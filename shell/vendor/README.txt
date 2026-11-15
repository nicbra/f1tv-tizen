TweetNaCl.js 1.0.3, nacl-fast.js, from the provided verified npm package.
Public domain / CC0: LICENSE.tweetnacl.
Local change: guard the optional Node crypto require in PRNG initialization. Verification and
SHA-512 do not require random bytes. No cryptographic routines were changed.
