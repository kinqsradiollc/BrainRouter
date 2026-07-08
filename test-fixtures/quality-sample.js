// Code-quality issues (NO security vulns) to exercise the BrainRouter code-review lens.

// Off-by-one: `<=` reads arr[arr.length], which is undefined → NaN.
function sumAll(arr) {
  let total = 0;
  for (let i = 0; i <= arr.length; i++) {
    total += arr[i];
  }
  return total;
}

// Missing empty/null handling: throws on an empty array or a user with no name.
function firstName(user) {
  return user.name.split(' ')[0];
}

// Unreachable duplicate branch + a dead no-op variable.
function classify(n) {
  let result;
  if (n > 0) {
    result = 'positive';
  } else if (n > 0) { // unreachable — same condition as above
    result = 'never';
  } else {
    result = 'non-positive';
  }
  const unused = 42; // no-op variable, never read
  return result;
}

module.exports = { sumAll, firstName, classify };
