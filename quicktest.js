'use strict';

var Db = require('./').Db

function microtime() {
    var ms = process.hrtime();
    return ms[0] * 1000 + ms[1] / 1e6;
}

/*
 * TEST: connect, authorize, make a warmup query, make a test query, loop test query.
 */
var db = new Db();
var t0 = microtime();
db.connect({ hostname: 'localhost', 'port': 3306, user: 'andras', password: '', database: 'test' }, function(err) {
    var t1 = microtime();
    if (err) throw err;
console.log("AR: auth time (%d ms)", t1 - t0);

    // var sql = 'SELECT 1, "foo", NOW(), NOW()';
    var sql = 'SELECT * FROM queue';
    // 0.29 ms after 'SELECT 1', vs 0.45 mariadb, 0.50 mysql, 0.67 mysql2
    //var sql = 'SELECT * FROM information_schema.collations LIMIT 100;'
    // 1.16ms, vs 1.136 mariadb
    //var sql = 'SELECT * from test;'

console.log("AR: writig query");
    db.query('SELECT 1', function() {
        t1 = microtime();
        db.query(sql, function(err, rows) {
            var t2 = microtime();
console.log("AR: got the rows in (%d ms)", t2 - t1, rows);

            var durations = new Array();
            t2 = microtime();
            var ncalls = 0;
            (function _loop(cb) {
                if (ncalls++ > 10) return cb()
                db.query(sql, function(err, rows) {
                    if (err) throw err
                    durations.push(rows.duration_ms)
                    _loop(cb);
                })
            })(function() {
                var t3 = microtime()
console.log("AR: 10 queries of '%s' in total %d ms: %s", sql, t3 - t2, durations.join(', '));
                db.quit(function(err, buf) {
                    // COM_QUIT does not respond, we never call to here
console.log("AR: did quit", err, buf);
                })
            })
        })
    })
})
