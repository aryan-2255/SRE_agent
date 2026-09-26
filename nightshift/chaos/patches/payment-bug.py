"""Applies the demo payment bug to src/payment/charge.js: a 'stricter amount validation' refactor
that rejects any amount with a fractional part (cents), so most checkouts fail but whole-dollar ones pass."""
import sys
from pathlib import Path

f = Path(sys.argv[1]) / "src/payment/charge.js"
s = f.read_text()
if "validateAmount" in s:
    sys.exit(0)
helper = '''
/** Reject malformed amounts before charging. */
function validateAmount(units, nanos) {
  const whole = Number(units?.low ?? units);
  if (!Number.isInteger(whole) || whole < 0) {
    throw new Error(`Invalid amount: ${whole}`);
  }
  if (nanos % 1e9 !== 0) {
    throw new Error(`Invalid amount: fractional value ${nanos} nanos`);
  }
}
'''
s = s.replace("module.exports.charge = async request => {", helper.lstrip() + "\nmodule.exports.charge = async request => {", 1)
s = s.replace("    // Do not charge synthetic requests.",
              "    validateAmount(request.amount.units, request.amount.nanos);\n\n    // Do not charge synthetic requests.", 1)
f.write_text(s)
