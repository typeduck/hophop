/* eslint-env mocha */
'use strict'

const Promise = require('bluebird')
const hophop = require('./')
const http = require('http')
const Request = require('request')
const express = require('express')
const AMQP = require('amqplib')
require('should')

const CONFIG = require('convig').env({
  AMQPHOST: 'amqp://guest:guest@localhost',
  PORT: 7777
})

function getChannel (exchange, bindKey) {
  return Promise.try(function () {
    return AMQP.connect(CONFIG.AMQPHOST)
  }).then(function (conn) {
    return conn.createChannel()
  }).then(function (channel) {
    let opts = {exclusive: true, durable: false, autoDelete: true, expires: 60000}
    return [
      channel.assertQueue(null, opts),
      channel.assertExchange(exchange, 'topic'),
      channel
    ]
  }).spread(function (q, ex, ch) {
    return ch.bindQueue(q.queue, ex.exchange, bindKey).then(function () {
      return { queue: q.queue, channel: ch, exchange: exchange }
    })
  })
}
function getJsonMessage (ch, q, triesLeft) {
  return Promise.try(function () {
    if (!triesLeft) { throw new Error('No tries left, no message no cry') }
    return ch.get(q, {noAck: true})
  }).then(function (msg) {
    if (msg === false) {
      return Promise.delay(10).then(function () {
        return getJsonMessage(ch, q, triesLeft - 1)
      })
    }
    msg.properties.contentEncoding.should.equal('UTF-8')
    msg.properties.contentType.should.equal('application/json')
    let body = JSON.parse(msg.content.toString(msg.properties.contentEncoding))
    body.should.have.property('date')
    body.should.have.property('request')
    body.should.have.property('response')
    body.properties = msg.properties
    body.fields = msg.fields
    return body
  })
}

describe('hophop', function () {
  let app = null
  let server = null
  let client = Promise.promisifyAll(Request.defaults({
    baseUrl: 'http://localhost:' + CONFIG.PORT,
    json: true
  }))
  beforeEach(function () {
    return Promise.try(function () {
      app = express()
      server = Promise.promisifyAll(http.createServer(app))
      return server.listenAsync(CONFIG.PORT)
    })
  })
  afterEach(function () { return server.closeAsync() })
  it('should connect via default options', function () {
    let obj = null
    return Promise.try(function () {
      app.use(function (req, res, next) {
        res.set('x-using-hophop', 'true')
        next()
      })
      app.use(hophop())
      app.use(function (req, res) { res.send({ok: true}) })
      return getChannel('amq.topic', 'http.#')
    }).then(function (o) {
      obj = o
      return client.getAsync('/foo/bar?one=1&two=2')
    }).then(function (response) {
      return getJsonMessage(obj.channel, obj.queue, 5)
    }).then(function (json) {
      json.request.method.should.equal('GET')
      json.request.path.should.equal('/foo/bar')
      json.request.hostname.should.equal('localhost')
      json.request.query.one.should.equal('1')
      json.request.query.two.should.equal('2')
      json.response.statusCode.should.equal(200)
      json.response._headers['x-using-hophop'].should.equal('true')
      json.fields.routingKey.should.equal('http.localhost')
    })
  })
  it('should succeed with existing AMQP connection', function () {
    let obj = null
    return Promise.try(function () {
      return AMQP.connect(CONFIG.AMQPHOST)
    }).then(function (connection) {
      app.use(hophop(connection))
      app.use(function (req, res) { res.send({ok: true}) })
      return getChannel('amq.topic', 'http.#')
    }).then(function (o) {
      obj = o
      return client.getAsync('/foo/bar?one=1&two=2')
    }).then(function (response) {
      return getJsonMessage(obj.channel, obj.queue, 5)
    }).then(function (json) {
      json.request.method.should.equal('GET')
      json.request.path.should.equal('/foo/bar')
      json.request.hostname.should.equal('localhost')
      json.request.query.one.should.equal('1')
      json.request.query.two.should.equal('2')
      json.response.statusCode.should.equal(200)
      json.fields.routingKey.should.equal('http.localhost')
    })
  })
  it('should succeed with Promise for AMQP connection', function () {
    let obj = null
    return Promise.try(function () {
      app.use(hophop(AMQP.connect(CONFIG.AMQPHOST)))
      app.use(function (req, res) { res.send({ok: true}) })
      return getChannel('amq.topic', 'http.#')
    }).then(function (o) {
      obj = o
      return client.getAsync('/foo/bar?one=1&two=2')
    }).then(function (response) {
      return getJsonMessage(obj.channel, obj.queue, 5)
    }).then(function (json) {
      json.request.method.should.equal('GET')
      json.request.path.should.equal('/foo/bar')
      json.request.hostname.should.equal('localhost')
      json.request.query.one.should.equal('1')
      json.request.query.two.should.equal('2')
      json.response.statusCode.should.equal(200)
      json.fields.routingKey.should.equal('http.localhost')
    })
  })
  it('should allow adding request, response properties', function () {
    let obj = null
    return Promise.try(function () {
      app.use(function (req, res, next) {
        req.drinking = ['Coffee', 'Water']
        res.eating = 'Chili con Carne'
        next()
      })
      app.use(hophop(null, {
        request: ['drinking'],
        response: ['eating']
      }))
      app.use(function (req, res) { res.send({ok: true}) })
      return getChannel('amq.topic', 'http.#')
    }).then(function (o) {
      obj = o
      return client.getAsync('/foo/bar?one=1&two=2')
    }).then(function (response) {
      return getJsonMessage(obj.channel, obj.queue, 5)
    }).then(function (json) {
      json.request.drinking.should.eql(['Coffee', 'Water'])
      json.response.eating.should.equal('Chili con Carne')
    })
  })
  it('should allow route altering and filtering', function () {
    let obj = null
    return Promise.try(function () {
      app.use(hophop(null, {
        route: function (req, res) {
          if (/^\/foo\/bar/.test(req.path)) { return false }
          return 'my.custom.route'
        }
      }))
      app.use(function (req, res) { res.send({ok: true}) })
      return getChannel('amq.topic', 'my.custom.#')
    }).then(function (o) {
      obj = o
      return Promise.mapSeries([
        '/foo/bar/baz',
        '/foo/bar/beep',
        '/foo/bar/buzz',
        '/this/one/goes'
      ], function (url) { return client.getAsync(url) })
    }).then(function () {
      return getJsonMessage(obj.channel, obj.queue, 5)
    }).then(function (json) {
      json.request.path.should.equal('/this/one/goes')
    })
  })
  it('should include millis as timing when deferred', function () {
    let obj = null
    return Promise.try(function () {
      app.use(hophop(null, {waitForFinish: true}))
      app.use(function (req, res) { res.send({ok: true}) })
      return getChannel('amq.topic', 'http.localhost.#')
    }).then(function (o) {
      obj = o
      return client.getAsync('/down/the/garden/path')
    }).then(function () {
      return getJsonMessage(obj.channel, obj.queue, 5)
    }).then(function (json) {
      json.should.have.property('millis')
      json.request.path.should.equal('/down/the/garden/path')
    })
  })
  it('should work when routing decision delayed', function () {
    let obj = null
    return Promise.try(function () {
      app.use(hophop(null, {
        waitForFinish: true,
        route: function (req, res) {
          return Promise.delay(500).then(function () {
            return hophop.defaultRoute(req, res)
          })
        }
      }))
      app.use(function (req, res) { res.send({ok: true}) })
      return getChannel('amq.topic', 'http.localhost.#')
    }).then(function (o) {
      obj = o
      return client.getAsync('/down/the/garden/path')
    }).delay(500).then(function () {
      return getJsonMessage(obj.channel, obj.queue, 5)
    }).then(function (json) {
      json.should.have.property('millis')
      json.request.path.should.equal('/down/the/garden/path')
    })
  })
})
