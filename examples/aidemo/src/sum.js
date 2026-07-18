'use strict';
// BUG: subtracts instead of adding. The failing test below proves it.
function sum(a, b) {
  return a - b;
}
module.exports = { sum };
