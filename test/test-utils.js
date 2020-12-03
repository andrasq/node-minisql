'use strict'

var assert = require('assert')
var utils = require('../lib/utils')

describe('utils', function() {
    describe('Bytes', function() {
        var bytes
        beforeEach(function(done) {
            bytes = new utils.Bytes()
            done()
        })
        it('open defaults pos', function(done) {
            bytes.open([1, 2, 3])
            assert.equal(bytes.tell(), 0)
            done()
        })
        it('databuf returns buf', function(done) {
            var buf = [1, 2, 3]
            var bytes = new utils.Bytes(buf)
            assert.equal(bytes.databuf(), buf)
            bytes.open(buf)
            assert.equal(bytes.databuf(), buf)
            bytes.open([1, 2, 3])
            assert.notEqual(bytes.databuf(), buf)
            done()
        })
        it('getLenenc returns number', function(done) {
            assert.strictEqual(bytes.open([0, 1, 2, 3]).getLenenc(), 0)
            assert.strictEqual(bytes.open([1, 1, 2, 3]).getLenenc(), 1)
            assert.strictEqual(bytes.open([249, 1, 2, 3]).getLenenc(), 249)
            assert.strictEqual(bytes.open([250, 1, 2, 3]).getLenenc(), 250)
            assert.strictEqual(bytes.open([251, 1, 2, 3]).getLenenc(), null)
            assert.strictEqual(bytes.open([252, 1, 2, 3]).getLenenc(), 1 + 2*256)
            assert.strictEqual(bytes.open([253, 1, 2, 3]).getLenenc(), 1 + 2*256 + 3*256*256)
            assert.strictEqual(bytes.open([254, 1, 0, 3, 0, 5, 6, 0, 1]).getLenenc(),
                1 + 3*256*256 + 5*256*256*256*256 + 6*65536*65536*256 + 1*65536*65536*65536*256)
            assert.strictEqual(isNaN(bytes.open([255, 1, 2 ,3]).getLenenc()), true)
            done()
        })
        it('getLenenc returns NaN if leading digit invalid', function(done) {
            bytes.open([0xff, 1, 1, 1, 1])
            assert.ok(isNaN(bytes.getLenenc()))
            done()
        })
        it('getNumberV returns number', function(done) {
            bytes.open([0, 3, 49, 50, 51], 1)
            assert.strictEqual(bytes.getNumberV(), 123)
            done()
        })
        it('getStringV returns string', function(done) {
            bytes.open([0, 3, 49, 50, 51], 1)
            assert.strictEqual(bytes.getStringV(), '123')
            done()
        })
        it('variable-length decoders decode null length as null', function(done) {
            bytes.open([0, 0xFB, 0, 0])
            bytes.seek(1)
            assert.strictEqual(bytes.getNumberV(), null)
            bytes.seek(1)
            assert.strictEqual(bytes.getStringV(), null)
            bytes.seek(1)
            assert.strictEqual(bytes.getBinaryV(), null)
            done()
        })
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
