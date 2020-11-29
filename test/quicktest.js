'use strict';

if (!/quicktest/.test(require('path').basename(process.argv[1]))) return

var qibl = require('qibl')
//var mariadb = require('mariadb');
//var minisql = mariasql()
var minisql = require('../')     // try mysql, mysql2, or mariasql()

var hrtime = process.hrtime || function() { var t = Date.now(); return [t/1000, 0] }
function microtime() {
    var ms = hrtime();
    return ms[0] * 1000 + ms[1] / 1e6;
}

/*
 * TEST: connect, authorize, make a warmup query, make a test query, loop test query.
 */
var creds = { hostname: 'localhost', 'port': 3306, database: 'test',
              user: process.env.USER, password: process.env.DBPASSWORD };
var t0 = microtime();
var db = minisql.createConnection(creds);
db.connect(function(err) {
    var t1 = microtime();
console.log("AR: auth time (%d ms)", t1 - t0);
    if (err) throw err;

    var t1, t2, sql;
    runSteps([
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
            sql = 'SELECT * FROM _test'
            t1 = microtime();
            db.query(sql, next);
        },
        function(next, rows) {
            t2 = microtime();
            var info = db.queryInfo && db.queryInfo() || { duration_ms: 'NA' }
            delete rows.meta;
console.log("AR: got %d rows in %d (%d ms)", rows.length, t2 - t1, info.duration_ms, rows);
            next();
        },
        function(next) {
            var limit = 10000;
            var ncalls = 0;
            t2 = microtime();
            (function _loop(cb) {
                if (ncalls++ >= limit) return cb()
                db.query(sql, function(err, rows) {
                    err ? cb(err) : _loop(cb)
                })
            })(function() {
                var t3 = microtime()
console.log("AR: %d queries of '%s' in total %d ms: %d avg", limit, sql, t3 - t2, (t3 - t2) / limit);
                next();
            })
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

// iterateSteps adapted from miniq, originally from qrepeat and aflow
function runSteps(steps, callback) {
    var ix = 0;
    (function _loop(err, a1, a2) {
        if (err || ix >= steps.length) return callback(err, a1, a2);
        steps[ix++](_loop, a1, a2);
    })()
}

// adapt mariadb to callbacks to run the benchmark
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
