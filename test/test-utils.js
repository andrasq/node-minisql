'use strict'

var assert = require('assert')
var utils = require('../lib/utils')

describe('utils', function() {
    describe('Bytes', function() {
    })

    describe('repeatFor', function() {
        var count;
        var counter = function(cb) { count += 1; cb() }

        beforeEach(function(done) {
            count = 0
            done()
        })

        it('repeats 0 times', function(done) {
            utils.repeatFor(0, counter, function(err) {
                assert.equal(count, 0)
                done()
            })
        })
        it('repeats 1 times', function(done) {
            utils.repeatFor(1, counter, function(err) {
                assert.equal(count, 1)
                done()
            })
        })
        it('repeats 3 times', function(done) {
            utils.repeatFor(3, counter, function(err) {
                assert.equal(count, 3)
                done()
            })
        })
        it('repeats 300k times', function(done) {
            utils.repeatFor(300000, counter, function(err) {
                assert.equal(count, 300000)
                // 300k in 10ms, or 3m in 50ms
                done()
            })
        })
    })
})
