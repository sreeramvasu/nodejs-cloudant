// Copyright © 2017, 2018 IBM Corp. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
'use strict';

const async = require('async');
const concat = require('concat-stream');
const CloudantError = require('./error.js');
const debug = require('debug')('cloudant:client');
const EventRelay = require('./eventrelay.js');
const PassThroughDuplex = require('./passthroughduplex.js');
const pkg = require('../package.json');
const utils = require('./clientutils.js');

const DEFAULTS = {
  maxAttempt: 3,
  usePromises: false
};

/**
 * Create a Cloudant client for managing requests.
 *
 * @param {Object} cfg - Request client configuration.
 */
class CloudantClient {
  constructor(cfg) {
    var self = this;

    cfg = cfg || {};
    self._cfg = Object.assign({}, DEFAULTS, cfg);

    var client;
    self._plugins = [];
    self._pluginIds = [];
    self._usePromises = false;
    self.useLegacyPlugin = false;

    // build plugin array
    var plugins = [];
    // If IAM key found in VCAP, add IAM plugin
    if (self._cfg.creds && self._cfg.creds.iamApiKey) {
      plugins.push({ iamauth: { iamApiKey: self._cfg.creds.iamApiKey } });
    } else if (typeof this._cfg.plugin === 'undefined' && typeof this._cfg.plugins === 'undefined') {
      plugins = [ 'cookieauth' ]; // default
    } else {
      [].concat(self._cfg.plugins).forEach(function(plugin) {
        if (typeof plugin !== 'function' || plugin.pluginVersion >= 2) {
          plugins.push(plugin);
        } else if (self.useLegacyPlugin) {
          throw new Error('Using multiple legacy plugins is not permitted');
        } else {
          self.useLegacyPlugin = true;
          client = plugin; // use legacy plugin as client
        }
      });
    }

    // initialize the internal client
    self._initClient(client);

    // add plugins
    self._addPlugins(plugins);
  }

  _addPlugins(plugins) {
    var self = this;

    if (!Array.isArray(plugins)) {
      plugins = [ plugins ];
    }

    plugins.forEach(function(plugin) {
      var cfg, Plugin;

      switch (typeof plugin) {
        // 1). Custom plugin
        case 'function':
          debug(`Found custom plugin: '${plugin.id}'`);
          Plugin = plugin;
          cfg = {};
          break;

        // 2). Plugin (with configuration): { 'pluginName': { 'configKey1': 'configValue1', ... } }
        case 'object':
          if (Array.isArray(plugin) || Object.keys(plugin).length !== 1) {
            throw new Error(`Invalid plugin configuration: '${plugin}'`);
          }

          var pluginName = Object.keys(plugin)[0];

          try {
            Plugin = require('../plugins/' + pluginName);
          } catch (e) {
            throw new Error(`Failed to load plugin - ${e.message}`);
          }

          cfg = plugin[pluginName];
          if (typeof cfg !== 'object' || Array.isArray(cfg)) {
            throw new Error(`Invalid plugin configuration: '${plugin}'`);
          }
          break;

        // 3). Plugin (no configuration): 'pluginName'
        case 'string':
          if (plugin === 'base' || plugin === 'default') {
            return; // noop
          }
          if (plugin === 'promises') {
            // maps this.request -> this.doPromisesRequest
            debug('Adding plugin: \'promises\'');
            self._cfg.usePromises = true;
            return;
          }

          try {
            Plugin = require('../plugins/' + plugin);
          } catch (e) {
            throw new Error(`Failed to load plugin - ${e.message}`);
          }

          cfg = {};
          break;

        // 4). Noop
        case 'undefined':
          return;
        default:
          throw new Error(`Invalid plugin configuration: '${plugin}'`);
      }

      if (self._pluginIds.indexOf(Plugin.id) !== -1) {
        debug(`Not adding duplicate plugin: '${Plugin.id}'`);
      } else {
        debug(`Adding plugin: '${Plugin.id}'`);
        self._plugins.push(
          // instantiate plugin
          new Plugin(self._client, Object.assign({}, cfg))
        );
        self._pluginIds.push(Plugin.id);
      }
    });
  }

  _initClient(client) {
    if (typeof client !== 'undefined') {
      debug('Using custom client.');
      this._client = client;
      return;
    }

    var protocol;
    if (this._cfg && this._cfg.https === false) {
      protocol = require('http');
    } else {
      protocol = require('https'); // default to https
    }

    var agent = new protocol.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 6
    });
    var requestDefaults = {
      agent: agent,
      gzip: true,
      headers: {
        // set library UA header
        'User-Agent': `nodejs-cloudant/${pkg.version} (Node.js ${process.version})`
      },
      jar: false
    };

    if (this._cfg.requestDefaults) {
      // allow user to override defaults
      requestDefaults = Object.assign({}, requestDefaults, this._cfg.requestDefaults);
    }

    debug('Using request options: %j', requestDefaults);

    this.requestDefaults = requestDefaults; // expose request defaults
    this._client = require('request').defaults(requestDefaults);
  }

  _doPromisesRequest(options, callback) {
    var self = this;

    return new Promise(function(resolve, reject) {
      self._doRequest(options, function(error, response, data) {
        if (typeof callback !== 'undefined') {
          callback(error, response, data);
        }
        if (error) {
          reject(error);
        } else {
          if (data) {
            try {
              data = JSON.parse(data);
            } catch (err) {}
          } else {
            data = { statusCode: response.statusCode };
          }
          if (response.statusCode >= 200 && response.statusCode < 400) {
            resolve(data);
          } else {
            reject(new CloudantError(response, data));
          }
        }
      });
    });
  }

  _doRequest(options, callback) {
    var self = this;

    if (typeof options === 'string') {
      options = { method: 'GET', url: options };  // default GET
    }

    var request = {};
    request.abort = false;
    request.clientCallback = callback;

    request.clientStream = new PassThroughDuplex();

    request.clientStream.on('error', function(err) {
      debug(err);
    });
    request.clientStream.on('pipe', function() {
      debug('Request body is being piped.');
      request.pipedRequest = true;
    });

    request.eventRelay = new EventRelay(request.clientStream);

    request.plugins = self._plugins;

    // init state
    request.state = {
      attempt: 0,
      maxAttempt: self._cfg.maxAttempt,
      // following are editable by plugin hooks during execution
      abortWithResponse: undefined,
      retry: false,
      retryDelayMsecs: 0
    };

    // add plugin stash
    request.plugin_stash = {};
    request.plugins.forEach(function(plugin) {
      // allow plugin hooks to share data via the request state
      request.plugin_stash[plugin.id] = {};
    });

    request.clientStream.abort = function() {
      // aborts response during hook execution phase.
      // note that once a "good" request is made, this abort function is
      // monkey-patched with `request.abort()`.
      request.abort = true;
    };

    async.forever(function(done) {
      request.doneCallback = done;
      request.done = false;

      // Fixes an intermittent bug where the `done` callback is executed
      // multiple times.
      done = function(error) {
        if (request.done) {
          debug('Callback was already called.');
          return;
        }
        request.done = true;
        return request.doneCallback(error);
      };

      request.options = Object.assign({}, options); // new copy
      request.response = undefined;

      // update state
      request.state.attempt++;
      request.state.retry = false;
      request.state.sending = false;

      debug(`Request attempt: ${request.state.attempt}`);

      utils.runHooks('onRequest', request, request.options, function(err) {
        utils.processState(request, function(stop) {
          if (request.state.retry) {
            debug('The onRequest hook issued retry.');
            return done();
          }
          if (stop) {
            debug(`The onRequest hook issued abort: ${stop}`);
            return done(stop);
          }

          debug(`Delaying request for ${request.state.retryDelayMsecs} Msecs.`);

          setTimeout(function() {
            if (request.abort) {
              debug('Client issued abort during plugin execution.');
              return done(new Error('Client issued abort'));
            }

            request.state.sending = true; // indicates onRequest hooks completed

            if (!request.pipedRequest) {
              self._executeRequest(request, done);
            } else {
              if (typeof request.pipedRequestBuffer !== 'undefined' && request.state.attempt > 1) {
                request.options.body = request.pipedRequestBuffer;
                self._executeRequest(request, done);
              } else {
                // copy stream contents to buffer for possible retry
                var concatStream = concat({ encoding: 'buffer' }, function(buffer) {
                  request.options.body = request.pipedRequestBuffer = buffer;
                  self._executeRequest(request, done);
                });
                request.clientStream.passThroughWritable
                  .on('error', function(error) {
                    debug(error);
                    self._executeRequest(request, done);
                  })
                  .pipe(concatStream);
              }
            }
          }, request.state.retryDelayMsecs);
        });
      });
    }, function(err) { debug(err.message); });

    return request.clientStream; // return stream to client
  }

  _executeRequest(request, done) {
    debug('Submitting request: %j', request.options);

    request.response = this._client(
      request.options, utils.wrapCallback(request, done));

    // define new source on event relay
    request.eventRelay.setSource(request.response);

    request.response
      .on('response', function(response) {
        request.response.pause();
        utils.runHooks('onResponse', request, response, function() {
          utils.processState(request, done); // process response hook results
        });
      });

    if (typeof request.clientCallback === 'undefined') {
      debug('No client callback specified.');
      request.response
        .on('error', function(error) {
          utils.runHooks('onError', request, error, function() {
            utils.processState(request, done); // process error hook results
          });
        });
    }
  }

  // public

  /**
   * Perform a request using this Cloudant client.
   *
   * @param {Object} options - HTTP options.
   * @param {requestCallback} callback - The callback that handles the response.
   */
  request(options, callback) {
    if (this._cfg.usePromises) {
      return this._doPromisesRequest(options, callback);
    } else {
      return this._doRequest(options, callback);
    }
  }
}

module.exports = CloudantClient;
