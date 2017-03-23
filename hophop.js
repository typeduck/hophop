'use strict'

const pick = require('lodash.pick')
const AMQP = require('amqplib')
const Promise = require('bluebird')

function hophop (connPromise, opts) {
  if (!opts) { opts = {} }
  if (typeof connPromise === 'string') {
    connPromise = AMQP.connect(connPromise)
  } else if (isThenable(connPromise) || isConnection(connPromise)) {
    connPromise = Promise.resolve(connPromise)
  } else {
    connPromise = AMQP.connect('amqp://guest:guest@localhost')
  }
  return (new HopHop(connPromise, opts)).route()
}

function isThenable (o) { return typeof (o && o.then) === 'function' }
function isConnection (o) {
  return (o && o.constructor && o.constructor.name) === 'ChannelModel'
}
function defaultRoute (req, res) {
  let parts = [req.protocol]
  let hostname = req.hostname.split('.')
  while (hostname.length) { parts.push(hostname.pop()) }
  return parts.join('.')
}

class HopHop {
  constructor (connPromise, opts) {
    if (!isThenable(connPromise)) {
      throw new Error('missing Promise for AMQP connection')
    }
    this.opts = opts
    if (opts.exchange == null) { opts.exchange = 'amq.topic' }
    if (opts.exchangeType == null) { opts.exchangeType = 'topic' }
    if (opts.route == null) { opts.route = defaultRoute }
    if (opts.request == null) { opts.request = [] }
    opts.request = opts.request.concat([
      'method', 'originalUrl', 'httpVersion',
      'hostname',
      'baseUrl', 'path', 'url', 'params', 'query',
      'cookies', 'signedCookies',
      'ip', 'ips', 'headers'
    ])
    if (opts.response == null) { opts.response = [] }
    opts.response = opts.response.concat([
      'statusCode', 'statusMessage',
      '_headers'
    ])
    this.channel = null
    connPromise.then((connection) => {
      return connection.createChannel()
    }).then((channel) => {
      this.channel = channel
      return channel.assertExchange(opts.exchange, opts.exchangeType)
    })
  }

  route () {
    return (req, res, next) => {
      Promise.try(() => {
        if (this.opts.waitForFinish) {
          req.hophopStart = new Date()
          res.on('finish', () => this.publish(req, res))
        } else {
          this.publish(req, res)
        }
        return true
      }).asCallback(next)
    }
  }

  publish (req, res) {
    return Promise.try(() => {
      return this.opts.route(req, res)
    }).then((routingKey) => {
      if (!routingKey) { return true }
      let exchange = this.opts.exchange
      let msg = {
        date: new Date(),
        request: pick(req, this.opts.request),
        response: pick(res, this.opts.response)
      }
      if (req.hophopStart) {
        msg.millis = new Date() - req.hophopStart
      }
      msg = new Buffer(JSON.stringify(msg))
      let opts = {
        contentType: 'application/json',
        contentEncoding: 'UTF-8'
      }
      if (this.channel && this.channel.publish) {
        this.channel.publish(exchange, routingKey, msg, opts)
      }
    })
  }
}

module.exports = hophop
module.exports.defaultRoute = defaultRoute
