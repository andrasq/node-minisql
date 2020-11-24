minisql
=======

Very small simplified experimental mysql database driver, functional but with deliberately
limited features.  _WORK IN PROGRESS_


Overview
--------

Can authenticate to mysql, run queries and return the results.  It supports data types
that are also supported by javascript: strings, numbers, binary blobs and null.  Dates and
timestamps are passed as strings.

Limitations:

- returns an array of values, not objects.  The column names and types are returned in `rows.columns`
- returns datetimes as strings, not Date objects
- longlongs, decimals, dates, timestamps, enums returned as strings


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

### db.connect( creds, onConnect(err) )

Creds:
- host - hostname to connect to.  The default is localhost at `0.0.0.0`.
- port - port to connect to.  Default is `3306`.
- user - username to authenticate as.  Required; no default.
- password - password for the user.  No default.
- database - database to connect to, if any.  No default.


### db.query( sql, callback(err, result) )

    db.query("SELECT * FROM test LIMIT 10", function(err, rows) {
        // ...
    })


Todo
----

- split query() and execute(), make query() test for TextResults packet, execute for OK packet
- `?` substitution
- support multi-paket responses larger than 16 mb
- connection pools (db sets)


Changelog
---------

- 0.1.0 - initial checkin of work in progress
