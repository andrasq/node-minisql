/*
 * Copyright (C) 2020 Andras Radics
 * Licensed under the Apache License, Version 2.0
 */

// npm install qibl mysql mysql2 mariadb

'use strict';

if (!/quicktest/.test(require('path').basename(process.argv[1]))) return

var util = require('util')
var qibl = require('qibl')
//var mysqlNative = require('mysql-native'); var minisql = nativesql() // NOTE: breaks with node-v7 and newer
//var minisql = require('mysql')
//var minisql = require('mysql2')
//var mariadb = require('mariadb'); var minisql = mariasql()
var minisql = require('../')
var utils = require('../lib/utils')

/*
 * TEST: connect, authorize, make a warmup query, make a test query, loop test query.
 */
var creds = { host: 'localhost', 'port': 3306, database: 'test',
              user: process.env.USER, password: process.env.DBPASSWORD };
var t0 = utils.microtime();
var db = minisql.createConnection(creds);
db.connect(function(err) {
    var t1 = utils.microtime();
console.log("AR: auth time (%d ms)", t1 - t0);
    if (err) throw err;

    var sql = 'SELECT * FROM _test'
    var t1, t2, sql;
    utils.runSteps([
        function(next) {
            db.query('select 1', next);
        },
        function(next) {
            db.query(
                'CREATE TEMPORARY TABLE _test' +
                '  (id INT, type VARCHAR(255), job VARCHAR(255), lock_tm DATETIME, locked_by VARCHAR(255))' +
                '  ENGINE=Memory CHARSET=utf8',
            next);
        },
        function(next) {
            db.query(
                'INSERT INTO _test VALUES' +
                '  (1, "jobtype-12345678", "jobdata-12345", NOW(), null),' +
                '  (2, "jobtype-2345", "jobdata-2345678", 0, null)',
            next);
        },
        function(next) {
            t1 = utils.microtime();
            db.query(sql, next);
        },
        function(next, rows, info) {
            t2 = utils.microtime();
            info = info || { duration_ms: 'NA' }
            delete rows.meta;
console.log("AR: got %d rows with '%s' in %d (%d ms)", rows.length, sql, t2 - t1, info.duration_ms, rows);
            next();
        },
        function(next) {
            selectSeries(db, sql, 10000, next)
        },
        function(next) {
            selectParallel(db, sql, 10000, next);
        },
        function(next) {
            selectSeries(db, sql, 10, next)
        },
        function(next) {
            selectParallel(db, sql, 10, next)
        },
        function(next) {
            selectSeries(db, sql, 1, next)
        },
        function(next) {
            selectParallel(db, sql, 1, next)
        },
        function(next) {
            db.end();
            next();
        },
    ], function(err) {
        if (err) throw err;
        console.log("AR: Done.");
    })
})

function selectSeries(db, sql, limit, callback) {
    var ndone = 0;
    var t2 = utils.microtime();
    (function _loop(cb) {
        if (ndone++ >= limit) return cb()
        db.query(sql, function(err, rows) {
            err ? cb(err) : _loop(cb);
        })
    })(function() {
        var t3 = utils.microtime();
console.log("AR: in-series %d queries of '%s' in total %d ms: %d avg", limit, sql, t3 - t2, (t3 - t2) / limit);
        callback();
    })
}

function selectParallel(db, sql, limit, callback) {
// FIXME: not supported, errors out
    var ndone = 0;
    var t2 = utils.microtime();
    for (var i=0; i<limit; i++) (function(i) {
        var _sql = sql.replace('*', '*, ' + i);
        db.query(_sql, function(err, rows) {
            if ((Array.isArray(rows[0]) && rows[0][rows[0].length - 1] !== i) && (rows[i] !== i)) {
                throw new Error(util.format('wrong value returned, got %d not %s', i, util.format(rows[0])))
            }
            if (++ndone < limit) return;
            var t3 = utils.microtime();
console.log("AR: parallel %d queries of '%s' in total %d ms: %d avg", limit, _sql, t3 - t2, (t3 - t2) / limit, "\n");
            callback();
        })
    })(i);
}

// adapt mariadb to mysql callback semantics so it can run the benchmark
function mariasql() { try {
    return {
        createConnection: function(creds) {
            var db = {
                _creds: creds,
                _db: null,
                connect: function(cb) {
                    mariadb.createConnection(this._creds)
                      .then(function(_db) { db._db = _db; _db.connect().then(function(conn) { cb() }) });
                },
                query: function(sql, cb) {
                    db._db.query(sql).then(function(ret, meta) { cb(null, ret) });
                },
                end: function(cb) {
                    db._db.end().then(cb);
                },
            };
            return db;
        }
    }
} catch (e) { } }

// adapt mysql-native to mysql callback semantics
// Note that mysql-native stopped working with node-v7
//    (Object.inherits: The "superCtor" argument must be of type Function)
function nativesql() {
    return {
        createConnection: function(creds) {
            var db = {
                _db: null,
                connect: function(cb) {
                    db._db = mysqlNative.createTCPClient() // default localhost:3306
                    db._db.auto_prepare = true
                    db._db.auth(creds.database, creds.user, creds.password)
                    cb()
                },
                query: function(sql, cb, x) {
                    var emitter = x === undefined ? db._db.query(sql, cb) : db._db.query(sql, cb, x)
                    var rows = []
                    emitter.on('row', function(row) { rows.push(row) })
                    emitter.on('end', function() { cb(null, rows) })
                    emitter.on('error', cb)
                },
                end: function(cb) {
                    db._db.close()
                    cb && cb()
                },
            }
            return db
        }
    }
}
