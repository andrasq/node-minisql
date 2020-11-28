minisql
=======
[![Build Status](https://travis-ci.org/andrasq/node-minisql.svg?branch=master)](https://travis-ci.org/andrasq/node-minisql)

Very small barebones mysql database driver, with deliberately limited features.  The goal is
a no-frills, low overhed command line interface to the database.  The current version 0.5.0
is 800 lines of javascript, 1/20th the size of the traditional packages.

Still somewhat experimental, but reads and writes the database.  _Work in progress._


Overview
--------

Can authenticate to mysql, run queries and return the results.  It supports data types
that are also supported by javascript: strings, numbers, binary blobs and null.  Dates and
timestamps are passed as strings.

Limitations:

- requires Protocol::41 for authentication
- returns an array of value arrays, not an array of objects
- longlongs, decimals returned as numbers (beware the loss of precision)
- dates, timestamps, enums returned as strings


Example
-------

    mysql = require('minisql')

    creds = {
        user: 'andras', password: '****',
        host: 'localhost', port: 3306, database: 'test',
    }

    db = new mysql.Db()
    db.connect(creds, function(err) {
        console.log('connected')

        db.query("SELECT 1, 'two', NOW();", function(err, rows) {
            // rows => [ [ 1, 'two', '2020-11-23 00:56:15' ], ]
        })
    })


Api
---

### db = minisql.createConnection( options )

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

### db.connect( onConnect(err) )

Connect to the database, authenticate with the credentials supplied to createConnection, and
configure the connection.

### db.query( sql, [params], callback(err, result ) )

Run the SQL query on the server, and return its response.  The response may be a an array of
rows or a status.  The params array, if provided, will be interpolated into the query string
with one parameter replacing each `?` in the query.  Numbers, blobs and arrays are recognized,
everything else is converted to string.

To obtain information about the query, including the column names, use `db.queryInfo()`.  It
returns timing `info.duration_ms`, and the column names with eg column 0 in `info.columns[0].name`.

    db.query("SELECT * FROM test LIMIT ?", [10], function(err, rows) {
        // => up to 10 rows
    })

### db.end( callback(err) )

Close the connection.  On a normal close the callback is _not_ called, but any errors will
be returned.


Todo
----

- connection pools (db sets)
- maybe: look for creds in `process.env.DBUSER` and `DBPASSWORD`
- "raw" mode, return response packets in buffer(s) without decoding (for trans-shipment)


Changelog
---------

- 0.5.0 - `createConnection`
- 0.4.0 - query param interpolation
- 0.3.0 - much faster queries
- 0.2.0 - working, including multi-packet queries and responses
- 0.1.0 - initial checkin of work in progress
