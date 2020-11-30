mysqule
=======
[![Build Status](https://travis-ci.org/andrasq/node-minisql.svg?branch=master)](https://travis-ci.org/andrasq/node-minisql)

Very small barebones mysql database driver, with deliberately limited features.  The goal is
a no-frills, low overhed interface to the database command line.  The current version 0.5.0
is 800 lines of javascript, 1/10th the size of the traditional packages.

Still somewhat experimental, but reads and writes the database.  _Work in progress._

* low latency
* pipelined queries
* parameter interpolation


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


Api
---

### db = mysqule.createConnection( options )

Create a new database connection manager.  This is a fast low-cost step, it just sets up
internal structures, must still `connect` to the database.  Equivalent to `new Db(options)`.

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

To obtain information about the query, including the column names, use `db.queryInfo()`.  It
returns timing `info.duration_ms`, and the column names in `info.columnNames`.

    db.query("SELECT * FROM test LIMIT ?", [10], function(err, rows) {
        // => up to 10 rows, each row an array of values
    })

### db.end( [callback(err)] )

Close the connection.


Todo
----

- connection pools (db sets)
- maybe: look for creds in `process.env.MYSQL_USER` and `MYSQL_PASSWORD`
- "raw" mode, return response packets in buffer(s) without decoding (for trans-shipment)
- see whether can avoid buffer copies, instead return array of chunks responses
- improve ci-test coverage (currently ~95% if pointed at a real db, 40% without)


Changelog
---------

- 0.6.0 - pipeline concurrent queries, not serialize
- 0.5.3 - experiment with _select, rewritten quicktest, first published version
- 0.5.0 - `createConnection`
- 0.4.0 - query param interpolation
- 0.3.0 - much faster queries
- 0.2.0 - working, including multi-packet queries and responses
- 0.1.0 - initial checkin of work in progress
