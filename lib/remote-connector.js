// Copyright IBM Corp. 2014,2016. All Rights Reserved.
// Node module: loopback-connector-remote
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

/**
 * Dependencies.
 */

var assert = require('assert');
var remoting = require('strong-remoting');
var utils = require('loopback-datasource-juggler/lib/utils');
var jutil = require('loopback-datasource-juggler/lib/jutil');
var RelationMixin = require('./relations');
var InclusionMixin = require('loopback-datasource-juggler/lib/include');

var reqOptionsSymbol = Symbol.for('loopback-connector-remote:reqOptions');

/**
 * Export the RemoteConnector class.
 */

module.exports = RemoteConnector;

/**
 * Create an instance of the connector with the given `settings`.
 */

function RemoteConnector(settings) {
  assert(typeof settings ===
    'object',
    'cannot initialize RemoteConnector without a settings object');
  this.client = settings.client;
  this.adapter = settings.adapter || 'rest';
  this.protocol = settings.protocol || 'http';
  this.root = settings.root || '';
  this.host = settings.host || 'localhost';
  this.port = settings.port || 3000;
  this.remotes = remoting.create(settings.options);
  this.name = 'remote-connector';

  if (settings.url) {
    this.url = settings.url;
  } else {
    this.url = this.protocol + '://' + this.host + ':' + this.port + this.root;
  }

  // handle mixins in the define() method
  var DAO = this.DataAccessObject = function() {
  };

}

RemoteConnector.SYMBOL_REQ_OPTIONS = reqOptionsSymbol;

RemoteConnector.prototype.connect = function() {
  this.remotes.connect(this.url, this.adapter);
};

RemoteConnector.initialize = function(dataSource, callback) {
  var connector = dataSource.connector =
    new RemoteConnector(dataSource.settings);
  connector.connect();
  process.nextTick(callback);
};

RemoteConnector.prototype.define = function(definition) {
  var Model = definition.model;
  var remotes = this.remotes;

  assert(Model.sharedClass,
      'cannot attach ' +
      Model.modelName +
      ' to a remote connector without a Model.sharedClass');

  jutil.mixin(Model, RelationMixin);
  jutil.mixin(Model, InclusionMixin);
  remotes.addClass(Model.sharedClass);
  this.resolve(Model);
};

RemoteConnector.prototype.resolve = function(Model) {
  var remotes = this.remotes;

  Model.sharedClass.methods().forEach(function(remoteMethod) {
    if (remoteMethod.name !== 'Change' && remoteMethod.name !== 'Checkpoint') {
      createProxyMethod(Model, remotes, remoteMethod);
    }
  });

  // setup a remoting type converter for this model
  remotes.defineType(Model.modelName, function(val) {
    return val ? new Model(val) : val;
  });
};

function createProxyMethod(Model, remotes, remoteMethod) {
  var scope = remoteMethod.isStatic ? Model : Model.prototype;
  var original = scope[remoteMethod.name];

  function remoteMethodProxy() {
    var args = Array.prototype.slice.call(arguments);
    var lastArgIsFunc = typeof args[args.length - 1] === 'function';
    var callback;
    if (lastArgIsFunc) {
      callback = args.pop();
    } else {
      callback = utils.createPromiseCallback();
    }

    // Support taking reqOptions off the callback, or off the last arg (after the callback)
    // which is commonly an options object - this allows it to be passed without changing the
    // method call signature, which might have unintended consequences when a remote method is
    // invoked in a non-remote context, especially for internal loopback methods
    var reqOptions;
    if (lastArgIsFunc) {
      if (typeof callback[reqOptionsSymbol] === 'object' && callback[reqOptionsSymbol]) {
        reqOptions = callback[reqOptionsSymbol];
        delete callback[reqOptionsSymbol];
      }
    }

    // If reqOptions was not set as a symbol on the callback, it can be set as a symbol on the
    // last object-arg of the called function. In this case we can extract the reqOptions off
    // the object and delete the property
    if (!reqOptions) {
      var lastArg = args[args.length - 1];
      if (
        typeof lastArg === 'object' &&
        lastArg &&
        typeof lastArg[reqOptionsSymbol] === 'object' &&
        lastArg[reqOptionsSymbol]
      ) {
        reqOptions = lastArg[reqOptionsSymbol]
        delete lastArg[reqOptionsSymbol];
      }
    }

    // Alternatively the reqOptions can be set as a standalone object as the last argument to
    // the function. In this case, if the last argument is an object with a `reqOptions` property,
    // we remove the whole object argument from the args that are passed through
    if (!reqOptions) {
      var lastArg = args[args.length - 1];
      if (
        typeof lastArg === 'object' &&
        lastArg &&
        typeof lastArg.reqOptions === 'object' &&
        lastArg.reqOptions
      ) {
        // remove lastArg
        reqOptions = args.pop().reqOptions;
      }
    }

    if (remoteMethod.isStatic) {
      var ctorArgs = [];
      remotes.invoke(remoteMethod.stringName, ctorArgs, args, reqOptions, callback);
    } else {
      var ctorArgs = [this.id];
      remotes.invoke(remoteMethod.stringName, ctorArgs, args, reqOptions, callback);
    }

    return callback.promise;
  }

  scope[remoteMethod.name] = remoteMethodProxy;
  remoteMethod.aliases.forEach(function(alias) {
    scope[alias] = remoteMethodProxy;
  });
}

function noop() {
}
