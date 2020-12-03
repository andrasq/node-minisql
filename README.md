mysqule
=======
[![Build Status](https://travis-ci.org/andrasq/node-minisql.svg?branch=master)](https://travis-ci.org/andrasq/node-minisql)

Very small barebones mysql database driver.  The goal was a no-frills, low overhed interface to
the database command line.  The current version 0.5.0 is 800 lines of javascript, 1/10th the
size of the traditional packages.  Tested to work with nodejs v0.8 through v15.3.

Still somewhat experimental, but reads and writes the database.  _Work in progress._

* low latency (< 0.2 ms response)
* pipelined queries (115k / sec)
* parameter interpolation
* connection setup / teardown steps
* nodejs v0.8 - v15


Overview
--------

Can authenticate to mysql, run queries and return the results.  It supports data types
that are also supported by javascript: strings, numbers, binary blobs and null.  Dates and
timestamps are passed as strings.

Restrictions:
- requires Protocol::41 for authentication
- returns an array of value arrays, not an array of objects
- longlongs, decimals returned as numbers (beware the loss of precision)
- dates, timestamps, enums returned as strings
- assumes max_allowed_packet is 16MB


Example
-------

    mysqule = require('mysqule')
    creds = { user: process.env.DBUSER, password: process.env.DBPASSWORD,
              host: 'localhost', port: 3306, database: 'test' }

    db = mysqule.createConnection(creds).connect(function(err) {
        db.query("SELECT 1, 'two', NOW();", function(err, rows) {
            // rows => [ [ 1, 'two', '2020-11-23 00:56:15' ], ]
        })
    })

Profile of verion 0.7.0, `node-v14.9.0 ./test/benchmark.js`:

    qtimeit=0.22.2 node=14.9.0 v8=8.4.371.19-node.13 platform=linux kernel=5.8.0-trunk-amd64 up_threshold=false
    arch=x64 mhz=4492[os] cpuCount=16 cpu="AMD Ryzen 7 3800X 8-Core Processor"
    -------- SELECT 1, "series", 3.5
    mysql        27,558 ops/sec   1023 >>>>>>>>>>
    mysql2       41,327 ops/sec   1534 >>>>>>>>>>>>>>>
    mariadb      49,097 ops/sec   1822 >>>>>>>>>>>>>>>>>>
    mysqule      65,165 ops/sec   2418 >>>>>>>>>>>>>>>>>>>>>>>>
    -------- SELECT 1, "parallel", 3.5
    mysql        29,753 ops/sec   1000 >>>>>>>>>>
    mysql2       42,727 ops/sec   1436 >>>>>>>>>>>>>>
    mariadb     105,797 ops/sec   3556 >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
    mysqule     115,937 ops/sec   3897 >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>


Api
---

### db = mysqule.createConnection( options )

Create a new database connection manager.  This is a fast low-cost step, it just sets up
internal structures, must still `connect` to the database.

Options:
- user - username to authenticate as.  Required; no default.
- password - password for the user.  No default.
- host - hostname to connect to.  The default is localhost at `0.0.0.0`.
- port - port to connect to.  Default is `3306`.
- database - database to connect to, if any.  No default.
- setup - TODO: array of sql commands to run before using the connection
- teardown - TODO: array of sql commands to run before closing the connection

### db = db.connect( onConnect(err) )

Connect to the database, authenticate with the credentials supplied to createConnection, and
configure the connection.  Returns the same db object it was called on, for chaining.

### db.query( sql, [params,] callback(err, result) )

Run the SQL query on the server, and return its response.  The response may be a an array of
rows or a status.  The params array, if provided, will be interpolated into the query string
with one parameter replacing each `?` in the query.  Numbers, blobs and arrays are recognized,
everything else is converted to string.

Returned errors will have the property `query` set to (an abridged version) of the failed query and
properties `errorCode` and `errorMessage` copied from the database server error response.

To obtain information about the query, including the column names, use `db.queryInfo()`.  It
returns timing `info.duration_ms`, and the column names in `info.columnNames`.

    db.query("SELECT * FROM test LIMIT ?", [10], function(err, rows) {
        // => up to 10 rows, each row an array of values
    })

### db.end( [callback(err)] )

Close the connection.


Ideas for Future Work
---------------------

- connection pools (db sets) (possibly dynamic min-max)
- improve ci-test coverage (currently ~95% if pointed at a real db, 40% without)
- automatic reconnect (on timeout and error)
- postgresql back-end plugin


Changelog
---------

- 0.7.0 - restructure files, more utils, more tests, faster small-packet extraction
- 0.6.1 - fix tests and benchmark
- 0.6.0 - pipeline concurrent queries, not serialize
- 0.5.3 - experiment with _select, rewritten quicktest, first published version
- 0.5.0 - `createConnection`
- 0.4.0 - query param interpolation
- 0.3.0 - much faster queries
- 0.2.0 - working, including multi-packet queries and responses
- 0.1.0 - initial checkin of work in progress
