# Verifying a release

Every `x402-spendguard` release is published from CI with a **signed provenance
attestation** (Sigstore/Fulcio, tokenless OIDC) that binds the exact published
tarball to the exact GitHub Actions workflow and git tag that built it. This page
shows how to check that for yourself.

## Read this first — a common false alarm

If you run `npm audit signatures` on an **older npm** (roughly npm ≤ 10.x, which
ships with Node 18 and 20), you may see:

```
1 package has an invalid attestation:
x402-spendguard@<version> (https://registry.npmjs.org/)
Someone might have tampered with this package since it was published on the registry!
```

**This is a known false positive in old npm's verifier — not tampering.** Older
npm CLIs mis-verify provenance bundles and print that alarming line for packages
that are perfectly intact. The fix is npm's, not ours: a clean pass requires a
**current npm on Node ≥ 22**. If you can't upgrade, use the version-independent
check in **Method B**, which doesn't depend on npm's verifier at all.

> Don't run `npm install x402-spendguard` *inside a clone of this repo* — there,
> `npm audit signatures` audits this project's dev dependencies, not the published
> artifact. Always verify from a throwaway directory, exactly as a real consumer would.

## Method A — the npm tool (needs Node ≥ 22 + current npm)

```bash
mkdir /tmp/verify-x402 && cd /tmp/verify-x402
npm init -y >/dev/null
npm install x402-spendguard
npm audit signatures
```

Expected on a current toolchain:

```
audited 1 package
1 package has a verified attestation
```

## Method B — verify the attestation directly (any npm/Node)

This checks the cryptographic facts without trusting npm's verifier version. Set
the version you want to check:

```bash
VER=0.2.1
cd "$(mktemp -d)"

# 1. Download the published tarball and hash it.
curl -s -o pkg.tgz "https://registry.npmjs.org/x402-spendguard/-/x402-spendguard-$VER.tgz"
TAR_SHA512=$(sha512sum pkg.tgz | awk '{print $1}')
echo "tarball  sha512: $TAR_SHA512"

# 2. Compare to what the registry records (must match).
npm view "x402-spendguard@$VER" dist.integrity   # sha512-... (base64 of the same digest)

# 3. Fetch the provenance attestation and read its subject digest + signer identity.
curl -s "https://registry.npmjs.org/-/npm/v1/attestations/x402-spendguard@$VER" -o att.json
node -e '
  const fs=require("fs"), {X509Certificate}=require("crypto");
  for (const a of JSON.parse(fs.readFileSync("att.json","utf8")).attestations) {
    const b=a.bundle, stmt=JSON.parse(Buffer.from(b.dsseEnvelope.payload,"base64").toString());
    console.log(a.predicateType);
    console.log("  subject sha512:", stmt.subject[0].digest.sha512);
    // the two attestations nest the signing cert differently; handle both shapes
    const vm=b.verificationMaterial;
    const raw=(vm.x509CertificateChain?.certificates?.[0]||vm.certificate)?.rawBytes;
    if (raw) console.log("  signer:", new X509Certificate(Buffer.from(raw,"base64")).subjectAltName);
  }
'
```

A genuine release satisfies all three:

- The **tarball sha512** (step 1) equals the registry `dist.integrity` digest (step 2).
- Each attestation's **subject sha512** (step 3) equals that same tarball digest —
  the attestation is about *this exact* tarball, not some other build.
- The **signer** is this project's release workflow. For `v0.2.1` it is:

  ```
  URI:https://github.com/x402spendguard/x402-spendguard/.github/workflows/release.yml@refs/tags/v0.2.1
  ```

  issued by `sigstore.dev`. The tag in the URI must match the version you're
  checking. Nothing else could have produced that signature — it is minted by the
  workflow's OIDC identity at publish time, with no long-lived token that could be
  stolen and reused.

If those three hold, the package you installed is byte-for-byte the artifact this
repository's CI built and published, and nothing has altered it in between.
