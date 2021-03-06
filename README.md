mysqule
=======
[![Build Status](https://travis-ci.org/andrasq/node-minisql.svg?branch=master)](https://travis-ci.org/andrasq/node-minisql)

Very small barebones mysql database driver.  The goal was a no-frills, low overhed interface to
the database command line.  Started out as 700 lines of javascript, tiny in comparison.
Tested to work with nodejs v0.7 through v15.3.

Still somewhat experimental.  _Work in progress._

* low latency (< 0.2 ms response)
* command pipelining (115k / sec)
* connection pooling (145k / sec)
* "smarter lru" connection scheduling
* parameter interpolation
* configurable connection setup / teardown
* nodejs v0.7 - v15

Overview
--------

Can authenticate to mysql, run queries and return the results.  It supports data types
that are also supported by javascript: strings, numbers, binary blobs and null.  Dates and
timestamps are passed as strings.

Restrictions:
- requires Protocol::41 for authentication
- returns arrays of values, not objects
- longlongs, decimals returned as numbers (beware the loss of precision)
- dates, timestamps, enums returned as strings
- assumes max_allowed_packet is 16MB


Example
-------

    mysqule = require('mysqule')
    creds = { user: process.env.DBUSER, password: process.env.DBPASSWORD,
              host: 'localhost', port: 3306, database: 'test',
              connections: 2 }

    db = mysqule.createConnection(creds).connect(function(err) {
        db.query('SELECT 1, "two", NOW()', function(err, rows) {
            // rows => [ [ 1, 'two', '2020-11-23 00:56:15' ], ]
        })
    })

Single- and 2-connection consecutive and 10-deep pipelined queries on version
`0.10.6` with `node-v14.15.1`:

    qtimeit=0.22.2 node=14.15.1 v8=8.4.371.19-node.17 platform=linux kernel=5.8.0-trunk-amd64 up_threshold=false
    arch=x64 mhz=4494[os] cpuCount=16 cpu="AMD Ryzen 7 3800X 8-Core Processor"
    timeGoal=8.45 opsPerTest=1 forkTests=false
    -------- SELECT 1, "series (latency)", 3.5
    mysql           27,071 ops/sec   1000 >>>>>>>>>>
    mysql2          39,410 ops/sec   1456 >>>>>>>>>>>>>>>
    mariadb         47,656 ops/sec   1760 >>>>>>>>>>>>>>>>>>
    mysqule         59,705 ops/sec   2205 >>>>>>>>>>>>>>>>>>>>>>
    mysqulePar      61,569 ops/sec   2274 >>>>>>>>>>>>>>>>>>>>>>>
    -------- SELECT 1, "pipelined (throughput)", 3.5
    timeGoal=8.45 opsPerTest=10 forkTests=false
    mysql           28,950 ops/sec   1000 >>>>>>>>>>
    mysql2          41,036 ops/sec   1417 >>>>>>>>>>>>>>
    mariadb         93,764 ops/sec   3239 >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
    mysqule        105,254 ops/sec   3636 >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
    mysqulePar     131,422 ops/sec   4540 >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>


Api
---

### db = mysqule.createConnection( options )

Create a new database connection manager.  This is a fast low-cost step, it just sets up
internal structures.  Returns a database handle that can run queries once `connect` has
bee called.

    db = mysqule.createConnection({
        user: 'andras',
        password: '****',
        setup: [
            'set global max_allowed_packet = 10000000',
        ],
    }).connect(function(err) {
        // connected, set up, ready to use
    })

Options:
- user - username to authenticate as.  Required; no default.
- password - password for the user.  No default.
- host - hostname to connect to.  The default is localhost at `0.0.0.0`.
- port - port to connect to.  Default is `3306`.
- database - database to connect to, if any.  No default.
- setup - array of sql commands to run before using the connection.  Default is `[]` none.
- teardown - array of sql commands to run before closing the connection.  Default is `[]` none.
- connections: how many connections to open to the database.  Default is 1.  Each connection
  can run any query; for stateful command sequences see `getConnection()` and `query()`.
- reconnect: TODO: reopen the db connection if it becomes unusable

### db = db.connect( whenConnected(err) )

Connect to the database, authenticate with the credentials supplied to createConnection, and
configure the connection(s).  Returns the same db object it was called on, for chaining.
Calls the `whenConnected` notification when the connection is ready to use.

The `setup` sql commands are run on every newly opened connection.  Any `setup` step error
is passed `whenConnected` and stops running any more setup steps.

### db.query( sql, [params,] callback(err, results, queryInfo) )

Run the SQL query on the server, and return its response.  The response may be a an array of
rows or a status.  The params array, if provided, will be interpolated into the query string
with one parameter replacing each `?` in the query.  Numbers, blobs and arrays are recognized,
everything else is converted to a single-quoted, escaped string.

Errors passed to the callback will have the property `query` set to (an abridged version) of the
failed query and properties `errorCode` and `errorMessage` copied from the database server error
response.

`queryInfo` contains information about the query, including the `columnNames`, `duration_ms`
elapsed time in milliseconds, and `conn` the connection that was used to make the query.
Some MySQL queries have connection-local side-effects.  Queries that rely on such shared
state can either get a preassigned connection with `db.getConnection()` or can chain queries
with `info.conn.query` to restrict them all to the same connection.

    db.query('SELECT * FROM test LIMIT ?', [10], function(err, rows, info) {
        // => up to 10 rows, each row an array of values
        // => info = { duration_ms: 3.52, columnNames: ['a', 'b'], conn: [Object] }
    })

### db.runQueries( queries, callback(err) )

Run each of the sql statements back to back.  Does not deliver results, but can be
useful for configuring a connection or setting up test scenarios.  A query error stops
the chain and is returned to the callback.

### dbConn = db.getConnection( )

Obtain a db handle that talks to a single connection.  The returned connection has all the
same methods of `db` but always uses the same connection.  The management methods `connect`
and `end` act on the underlying `db` object and not on just the connection.

### db.end( [callback(firstError, allErrors)] )

Run the `teardown` steps on each connection and close them.  Any teardown steps errors are
passed to the callback, if provided.  The teardown steps stop running on error, but all sessions
are closed.  Calls back with `null` if there no errors, else the errors.  Each error has a
property `connectionId` set to the id of its connection.

Observations
------------

- all in all, the MySQL binary protocol is refreshingly simple (once mind wrapped around it)
- short strings benefits from js utf8 string conversion library (used my own q-utf8 that I wrote for BSON coding)
- mariadb crashes under node-v15 (args to write?)
- binary text is an easier format to encode/decode than mongodb binary
- localhost socket speed is 3.4gb / sec, buffer concat is 5.5gb/s
- raw mode data streaming might not be worth the effort, conversion takes 10%, 17ms out of a 170ms response
  A: typical 17mb send/receive timing: compose+write 15ms, query+response 140ms, decode 17ms
  A: but would remove cpu load from the middle tier
- passing arrays of 65k chunks is not worth it, concat takes 3 ms per 17 megabytes (mysql packet size)
  A: 17mb and 34mb buffer copies (data chunks to packet) only take 3ms per 17mb out of 172 and 349ms call durations, ie 5.5GB/s
  (160ms of the 172ms test is getting from the write to first response byte from db, 175ms to last response
    => 15ms for 17+17mb via tcp/ip ie 3.4GB/s)
- it is slightly faster to buf.copy concat than to Buffer.concat (1-2%, but not as visible on huge concats)
  Of a 160ms response chunk concat is 3.2ms (and packet merge another 3.7ms), so dedicated raw mode support
    would save 6.9ms / 160ms = 4.3%
- tune the common cases: optimizing sub-chunk packets netted another 10% speedup, from 52k to 58k/s v10, 59k to 65k/s v14.
  This might be a common occurrence for even small serial queries, also a bit piplined queries
  (effect is too large to be the 3-5% caching effect often seen with nodejs)
- mapping the row values into a hash of key-value pairs slows queries 6-8% (still faster than mariadb)
- mysql is running 80% busy with small-query workload, nodejs 40% (single thread) (count(*) from collations, 6k/sec)
  (series: 85% node, 50% mysql)
  (parallel: 110% node, 85% mysql)
  (count(*): 20% node, 95% mysql)
  (100 rows from collations: 40% node, 60% mysql)
- sending a 100mb string takes 960 ms (convert string to bytes and write)
  (Sending a binary blob is slower, it is sent as a hex dump)
- receiving 100mb takes 490 mb converted to a string, and 460 mb as a binary blob (Buffer)
- query param interpolation (4 short num, num, string, num) adds 100ms per 100k queries prepared, from 60ms to 160ms,
  about 10% of the max observed db throughput of about 110k queries per second.  Compiled interpolation could lower
  this to about 3% (see compileVinterpolate in qibl@1.8.0-dev)
- connection pools can boost throughput when the query load is on the database, not nodejs.
  For simple queries nodejs is the bottleneck (115 -> 123k/s), but for longer duration queries multiple connections
  can greatly increase throughput (6 conns 6k -> 24k/sec)
- speed is primarily affected packetization and string conversion, where paying attention to the critical path makes
  a difference


Ideas and Todo
--------------

- automatic reconnect (on timeout and error)
- canonicalize various status responses from non-query calls eg insert, update, load
- add support for load data local infile
- db.reconnect() call to add connections to the pool


Changelog
---------

- 0.10.6 - faster lru connection scheduling
- 0.10.3 - smarter lru connection scheduling
- 0.10.2 - fix boolean/null/date `?` interpolation, remove SessionList and notifyState
- 0.10.0 - setup/teardowns happen in db, destroy conn on seq num error, expose sessionDb not connection
- 0.9.2 - return info from runQueries too, have end() close all and return all errors
- 0.9.1 - faster pipelined query read queueing, always return query info
- 0.9.0 - return query info to query and deprecate qureyInfo, expose runQueries
- 0.8.9 - queue waiting readers on a quicker list
- 0.8.8 - destroy closed/errored connections, error out queries (todo: reconnect)
- 0.8.7 - new versions of legacy chunker, packeter
- 0.8.5 - default to the legacy packeter
- 0.8.4 - make packeteer content-agnostic, unify chunker and packeter
- 0.8.3 - faster connection selection, improved code layout
- 0.8.2 - fix decodeBytesTo dst, fix integration test db setup, cleanups
- 0.8.0 - db now either a connection or a connection pool, setup/teardown commands,
          deprecated first-draft interfaces
- 0.7.0 - restructure files, more utils, more tests, faster small-packet extraction
- 0.6.1 - fix tests and benchmark
- 0.6.0 - pipeline concurrent queries, not serialize
- 0.5.3 - experiment with _select, rewritten quicktest, first published version
- 0.5.0 - `createConnection`
- 0.4.0 - query param interpolation
- 0.3.0 - much faster queries
- 0.2.0 - working, including multi-packet queries and responses
- 0.1.0 - initial checkin of work in progress
