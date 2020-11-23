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
- no decimals, no Date objects, no longlong integers


Example
-------

    mysql = require('minisql')
    db = new mysql.Db()
    db.createConnection({ host: 'localhost', port: 3306 }, function(err) {
        db.query("SELECT 1, 'two', NOW();", function(err, rows) {
            // rows => [ [ 1, 'two', '2020-11-23 00:56:15' ], ]
        })
    })


Changelog
---------

- 0.1.0 - initial checkin of work in progress
