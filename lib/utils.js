/*
 * useful utilities copied here from sources as indicated
 *
 * Copyright (C) 2020 Andras Radics
 * Licensed under the Apache License, Version 2.0
 */

'use strict'

module.exports = {
    repeatFor: repeatFor,
    runSteps: runSteps,
}

function repeatFor(n, proc, callback) {
    var ix = 0, ncalls = 0;
    (function _loop(err) {
        if (err || n-- <= 0) return callback(err);
        (ncalls++ > 100) ? process.nextTick(_loop) : proc(_loop, ix++);
    })()
}

// iterateSteps adapted from miniq, originally from qrepeat and aflow
function runSteps(steps, callback) {
    var ix = 0;
    (function _loop(err, a1, a2) {
        if (err || ix >= steps.length) return callback(err, a1, a2);
        steps[ix++](_loop, a1, a2);
    })()
}
