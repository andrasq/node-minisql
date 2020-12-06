/*
 * Copyright (C) 2020 Andras Radics
 * Licensed under the Apache License, Version 2.0
 */

'use strict'

var assert = require('assert')
var utils = require('../lib/utils')
var my = require('../lib/mysql')

// EOF
var eofPacket = utils.fromBuf('05 00 00 05 fe 00 00 02 00'.replace(/ /g, ''), 'hex')
// 1001 columns
var textResultsetPacket = utils.fromBuf('05 00 00 02 fc e9 03'.replace(/ /g, ''), 'hex')
// row with "ABC", 23.5
var resultRowPacket3 = utils.fromBuf('09 00 00 02 03 41 42 43 04 32 33 2e 35'.replace(/ /g, ''), 'hex')
// Error packet of "No database selected", sql state 42000, error_code 1046
var errorPacket = utils.fromBuf(
    '1d 00 00 4d ff 16 04 23 33 44 30 30 30 4e 6f 20 64 61 74 61 62 61 73 65 20 73 65 6c 65 63 74 65 64'.replace(/ /g, ''), 'hex')

describe('mysql', function() {
    describe('OkPacket', function() {
    })
    describe('EofPacket', function() {
        var p1, p2
        it('is detected by isEofPacket', function(done) {
            assert.equal(my.isEofPacket(eofPacket), true)
            done()
        })
        it('decodes seq id and header', function(done) {
            var packet = p1 = my.decodeEofPacket(eofPacket)
            assert.equal(packet._seqId, 5)
            assert.equal(packet._type, 'EOF')
            assert.equal(packet.header, my.myHeaders.EOF)
            done()
        })
        it('is decoded by decodeResponsePacket', function(done) {
            var packet = p2 = my.decodeResponsePacket(eofPacket)
            assert.deepEqual(p2, p1)
            done()
        })
    })
    describe('ErrorPacket', function() {
        var p1, p2
        it('is decoded by decodeResponsePacket', function(done) {
            var packet = p1 = my.decodeResponsePacket(errorPacket)
            assert.equal(packet._seqId, 77)
            assert.equal(packet._type, 'ERROR')
            assert.equal(packet.header, my.myHeaders.ERROR)
            assert.equal(packet.error_code, 1046)
            assert.equal(packet.error_message, 'No database selected')
            assert.equal(packet.sql_state_marker, '#')
            assert.equal(packet.sql_state, '3D000')
            done()
        })
        it('is decoded by decodeErrorPacket', function(done) {
            var p2 = my.decodeErrorPacket(errorPacket)
            assert.deepEqual(p2, p1)
            done()
        })
        it('is distinguished from ErrorProgress', function(done) {
            var progressPacket = utils.fromBuf(errorPacket)
            progressPacket[5] = progressPacket[6] = 0xff
            var packet = my.decodeErrorPacket(progressPacket)
            assert.equal(packet._seqId, 77)
            assert.equal(packet._type, 'ERROR_PROGRESS')
            assert.equal(packet.header, my.myHeaders.ERROR)
            assert.equal(packet.error_code, 0xffff)
            assert.equal(packet.progress_info, 'No database selected')
            done()
        })
    })
    describe('TextResultsetPacket', function() {
        it('is decoded by decodeResponsePacket', function(done) {
            var packet = my.decodeResponsePacket(textResultsetPacket)
            assert.equal(packet._seqId, 2)
            assert.equal(packet._type, 'RESULTS')
            assert.equal(packet.column_count, 1001)
            done()
        })
    })
})
