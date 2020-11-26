minisql
=======

Very small barebones mysql database driver, with deliberately limited features.  The goal is
a no-frills, low overhed command line interface to the database.  The current version 0.2.0
is implemented in 700 lines of javascript vs 8000-12000 for the traditional packages.

_WORK IN PROGRESS_


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

### db = new Db()

Create a new database connection manager.  This is a fast low-cost step, it just sets up
internal structures, must still `connect` to the database.

### db.connect( creds, onConnect(err) )

Connect to the databaes, authenticate with the provided credentials, and configure the
connection.

Creds:
- host - hostname to connect to.  The default is localhost at `0.0.0.0`.
- port - port to connect to.  Default is `3306`.
- user - username to authenticate as.  Required; no default.
- password - password for the user.  No default.
- database - database to connect to, if any.  No default.
- setup - TODO: array of sql commands to run before using the connection
- teardown - TODO: array of sql commands to run before closing the connection

### db.query( sql, callback(err, result) )

    db.query("SELECT * FROM test LIMIT 10", function(err, rows) {
        // ...
    })

### db.end( callback(err) )

Close the connection.  On a normal close the callback is _not_ called, but any errors will
be returned.


Todo
----

- split query() and execute(), make query() test for TextResults packet, execute for OK packet
- provide alternate api that returns rows of name-value hashes, not arrays of values
- `?` substitution
- connection pools (db sets)
- maybe: look for creds in `process.env.DBUSER` and `DBPASSWORD`


Changelog
---------

- 0.1.0 - initial checkin of work in progress
