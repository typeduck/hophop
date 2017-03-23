# HopHop

Publish HTTP request/response information to
an [AMQP Server](https://www.rabbitmq.com/).

## Usage

```js
const hophop = require('hophop')

// default options, e.g. 'amqp://guest:guest@localhost'
app.use(hophop())

// set the AMQP connection
app.use(hophop('amqp://user:password@host/vhost'))

// reuse existing connection (or Promise for one)
app.use(hophop(amqpConnection))
app.use(hophop(amqpConnectionPromise))

// detailed options in second argument
app.use(hophop(amqpConnection, {
  exchange: 'amq.topic',  // hophop will call assertExchange()
  exchangeType: 'topic',  // using these parameters
  route: function (req, res) {
    // custom function to set the Routing Key for publishing
    // return string / Promise.resolve(string): routing key
    // return falsey / Promise.resolve(falsey): avoids publishing
    // default is [schema].[backwards-domain-name]
    // e.g.: 'http.com.example.subdomain' for 'http://subdomain.example.com'
    // e.g.: 'https.com.example for 'https://example.com'
  },
  request: ['additional', 'request', 'properties'],
  response: ['additional', 'response', 'properties'],
  waitForFinish: false, // true to wait for response 'finish' event
}))
```

This middleware publishes information about an HTTP request & response to an
AMQP Server (e.g. [RabbitMQ](https://www.rabbitmq.com/)). This library will
create its
own [channel](http://www.squaremobius.net/amqp.node/channel_api.html#channel) to
publish messages on, so you can pass it an existing connection which you use for
other things.

## Published data

The request/response information is published as JSON with UTF-8 encoding:

- **date**: ISO-8601 string, e.g. "2017-03-23T12:23:11.513Z"
- **request**: object, following properties taken
  from [Express Request](http://expressjs.com/en/4x/api.html#req)
  - method, hostname, httpVersion, hostname, baseUrl, path, url, params, query,
    cookies, signedCookies, ip, ips, headers;
  - additional properties from `request` option will be copied
- **response**: object, following properties taken
  from [Express Reponse](http://expressjs.com/en/4x/api.html#res)
  - statusCode, statusMessage, _headers (undocumented property!)
  - additional properties from `response` option will be copied
- **millis**: only if `waitForFinish` was set, the number of milliseconds
  between middleware invocation and publishing time (response 'finish')

Note that the request/response objects from express are extended from the
(Node.js HTTP API)[https://nodejs.org/api/http.html].

## Advanced Usage

### Including more data

Note that in the above examples, any HTTP request body is not included. This is
by design, to avoid sending potentially large amounts of data to the AMQP server
by default.

However, you can indeed pass this information along, here's an example
using [body-parser](https://github.com/expressjs/body-parser):

```js
app.use(bodyParser.json())
app.use(hophop(amqpConn, { request: ['body'] }))
```

Similarly, you can publish data that is processed by other middleware. For
example, include user information from [passportjs](http://passportjs.org/).

```js
app.use(hophop(amqpConn, { request: ['user'] }))
```

Remember to set up your middleware in the proper order. By default, HopHop will
immediately publish the information it has on the request/response objects, so
it won't have anything from middleware that runs after it.

Eiher invoke the HopHop middleware after other middleware, or use the
`waitForFinish` option to run publishing at the end.

### Routing

The `route` option is used both for filtering requests and for changing the
routing key.

If you only want filtering, you must somehow provide a routing key for data you
want to publish. You can still access the default functionality like so:

```js
app.use(hophop(amqpConn, {
  route: function (req, res) {
    if (/127\.0\.0\.1$/.test(req.ip)) { return false }
    return hophop.defaultRoute(req, res)
  }
}))
```

And don't forget that your `route` function can return a Promise, so you can
run asynchronous operations.

```js
app.use(hophop(amqpConn, {
  route: function (req, res) {
    return Promise.try(function () {
      return lookupCountryCodeForIp(req.ip)
    }).then(function (code) {
      if (code === 'CA') { return false } // Canadians are too nice to track
      return 'MilkyWay.SolarSystem.Earth.' + code
    })
  }
}))
```
