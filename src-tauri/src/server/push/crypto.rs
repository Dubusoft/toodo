//! Web Push message encryption (RFC 8291: `aes128gcm` content encoding of RFC 8188 with
//! keys from an ECDH exchange with the subscription) and the application server's VAPID
//! identity (RFC 8292): an ES256 key that signs a short-lived token for each push service.

use std::fs;
use std::io;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::error::Unspecified;
use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair};
use ring::{aead, agreement, hkdf};

use crate::domain::push::{AUTH_LEN, P256DH_LEN};

pub fn base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Decodes unpadded base64url, as browsers report subscription keys; padding is tolerated.
pub fn from_base64url(text: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text.trim_end_matches('=')).ok()
}

/// The record size announced in the message header. A message is one record, so it must
/// hold the plaintext, its delimiter, and the authentication tag.
const RECORD_SIZE: u32 = 4096;

const TAG_LEN: usize = 16;

/// The header before the record: salt, record size, key id length, and the key id (the
/// sender's uncompressed P-256 public key).
const HEADER_LEN: usize = 16 + 4 + 1 + P256DH_LEN;

/// The largest plaintext of a message push services must accept: 4096 bytes in all,
/// header included (RFC 8291, section 4), which leaves 3993.
pub const MAX_PLAINTEXT: usize = 4096 - HEADER_LEN - TAG_LEN - 1;

/// The application server's signing key, kept as PKCS#8 in a file only the owner can read.
pub struct VapidKey {
    pair: EcdsaKeyPair,
    rng: SystemRandom,
}

impl VapidKey {
    /// Reads the key at `path`, or creates it there on first start. Browsers bind their
    /// subscriptions to this key, so replacing it would silently end every subscription.
    pub fn load_or_create(path: &Path) -> io::Result<Self> {
        let rng = SystemRandom::new();
        let pkcs8 = match fs::read(path) {
            Ok(bytes) if !bytes.is_empty() => {
                crate::mcp::make_private(path)?;
                bytes
            }
            Ok(_) => {
                fs::remove_file(path)?;
                create(path, &rng)?
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => create(path, &rng)?,
            Err(error) => return Err(error),
        };
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &pkcs8, &rng)
            .map_err(|error| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("{} is not a P-256 key: {error}", path.display()),
                )
            })?;
        Ok(Self { pair, rng })
    }

    /// The public key as an uncompressed point: the `applicationServerKey` browsers
    /// subscribe with.
    pub fn public_key(&self) -> &[u8] {
        self.pair.public_key().as_ref()
    }

    /// The `Authorization` header for a push service at `audience` (its origin): a JWT
    /// with the contact `subject` that expires at `expires` (Unix seconds), and the key.
    pub fn authorization(&self, audience: &str, subject: &str, expires: i64) -> String {
        let header = base64url(br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = serde_json::json!({ "aud": audience, "exp": expires, "sub": subject });
        let signed = format!("{header}.{}", base64url(claims.to_string().as_bytes()));
        let signature = self
            .pair
            .sign(&self.rng, signed.as_bytes())
            .expect("signing with a valid P-256 key does not fail");
        format!(
            "vapid t={signed}.{}, k={}",
            base64url(signature.as_ref()),
            base64url(self.public_key())
        )
    }
}

fn create(path: &Path, rng: &SystemRandom) -> io::Result<Vec<u8>> {
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, rng)
        .map_err(|_| io::Error::other("cannot generate a P-256 key"))?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    io::Write::write_all(&mut options.open(path)?, pkcs8.as_ref())?;
    Ok(pkcs8.as_ref().to_vec())
}

/// Whether `key` is a point on P-256 that a message can be encrypted for.
pub fn is_valid_public_key(key: &[u8; P256DH_LEN]) -> bool {
    let rng = SystemRandom::new();
    agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng)
        .and_then(|private| {
            agreement::agree_ephemeral(
                private,
                &agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, key),
                |_| (),
            )
        })
        .is_ok()
}

/// Encrypts `plaintext` (at most [`MAX_PLAINTEXT`] bytes) for the subscription with the
/// public key `ua_public` and the secret `auth`, with a fresh key pair and salt.
pub fn encrypt(
    ua_public: &[u8; P256DH_LEN],
    auth: &[u8; AUTH_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, Unspecified> {
    if plaintext.len() > MAX_PLAINTEXT {
        return Err(Unspecified);
    }
    let rng = SystemRandom::new();
    let private = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng)?;
    let as_public = private.compute_public_key()?;
    let mut salt = [0u8; 16];
    rng.fill(&mut salt)?;
    let secret = agreement::agree_ephemeral(
        private,
        &agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, ua_public),
        <[u8]>::to_vec,
    )?;
    encrypt_with(
        &secret,
        ua_public,
        as_public.as_ref(),
        auth,
        &salt,
        plaintext,
    )
}

/// The message for a known ECDH secret, key pair, and salt (RFC 8291, section 3.4).
fn encrypt_with(
    ecdh_secret: &[u8],
    ua_public: &[u8],
    as_public: &[u8],
    auth: &[u8],
    salt: &[u8; 16],
    plaintext: &[u8],
) -> Result<Vec<u8>, Unspecified> {
    let (cek, nonce) = content_keys(ecdh_secret, ua_public, as_public, auth, salt)?;
    let mut record = plaintext.to_vec();
    // The delimiter of the last (here: only) record, without further padding.
    record.push(2);
    let key = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_128_GCM, &cek)?);
    key.seal_in_place_append_tag(
        aead::Nonce::try_assume_unique_for_key(&nonce)?,
        aead::Aad::empty(),
        &mut record,
    )?;
    let mut message = Vec::with_capacity(16 + 4 + 1 + as_public.len() + record.len());
    message.extend_from_slice(salt);
    message.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    message.push(u8::try_from(as_public.len()).map_err(|_| Unspecified)?);
    message.extend_from_slice(as_public);
    message.extend_from_slice(&record);
    Ok(message)
}

/// The content encryption key and nonce: the ECDH secret is first combined with the
/// subscription's `auth` secret and both public keys, then keyed by the message's salt.
fn content_keys(
    ecdh_secret: &[u8],
    ua_public: &[u8],
    as_public: &[u8],
    auth: &[u8],
    salt: &[u8],
) -> Result<([u8; 16], [u8; 12]), Unspecified> {
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(as_public);
    let mut ikm = [0u8; 32];
    hkdf_sha256(auth, ecdh_secret, &key_info, &mut ikm)?;
    let mut cek = [0u8; 16];
    hkdf_sha256(salt, &ikm, b"Content-Encoding: aes128gcm\0", &mut cek)?;
    let mut nonce = [0u8; 12];
    hkdf_sha256(salt, &ikm, b"Content-Encoding: nonce\0", &mut nonce)?;
    Ok((cek, nonce))
}

struct Len(usize);

impl hkdf::KeyType for Len {
    fn len(&self) -> usize {
        self.0
    }
}

fn hkdf_sha256(salt: &[u8], ikm: &[u8], info: &[u8], out: &mut [u8]) -> Result<(), Unspecified> {
    hkdf::Salt::new(hkdf::HKDF_SHA256, salt)
        .extract(ikm)
        .expand(&[info], Len(out.len()))?
        .fill(out)
}

/// Decrypts a message as the subscription would, given the ECDH secret it computes.
#[cfg(test)]
pub(crate) fn decrypt_with(
    ecdh_secret: &[u8],
    ua_public: &[u8],
    auth: &[u8],
    message: &[u8],
) -> Vec<u8> {
    let salt = &message[..16];
    let key_len = usize::from(message[20]);
    let as_public = &message[21..21 + key_len];
    let (cek, nonce) = content_keys(ecdh_secret, ua_public, as_public, auth, salt).unwrap();
    let key = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_128_GCM, &cek).unwrap());
    let mut record = message[21 + key_len..].to_vec();
    let plain = key
        .open_in_place(
            aead::Nonce::try_assume_unique_for_key(&nonce).unwrap(),
            aead::Aad::empty(),
            &mut record,
        )
        .unwrap();
    assert_eq!(plain.last(), Some(&2), "last record delimiter");
    plain[..plain.len() - 1].to_vec()
}

/// The public key of the sender of `message`: the key id in its header.
#[cfg(test)]
pub(crate) fn sender_key(message: &[u8]) -> &[u8] {
    &message[21..21 + usize::from(message[20])]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(text: &str) -> Vec<u8> {
        from_base64url(text).unwrap()
    }

    /// The example of RFC 8291, section 5.
    #[test]
    fn encrypts_the_rfc_8291_example() {
        let ecdh_secret = d("kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs");
        let ua_public = d(
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        );
        let as_public = d(
            "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
        );
        let auth = d("BTBZMqHH6r4Tts7J_aSIgg");
        let salt: [u8; 16] = d("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let message = encrypt_with(
            &ecdh_secret,
            &ua_public,
            &as_public,
            &auth,
            &salt,
            b"When I grow up, I want to be a watermelon",
        )
        .unwrap();
        assert_eq!(
            base64url(&message),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
    }

    #[test]
    fn a_subscription_decrypts_what_is_encrypted_for_it() {
        let rng = SystemRandom::new();
        let receiver =
            agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).unwrap();
        let ua_public: [u8; P256DH_LEN] = receiver
            .compute_public_key()
            .unwrap()
            .as_ref()
            .try_into()
            .unwrap();
        let auth = [9u8; AUTH_LEN];
        assert!(is_valid_public_key(&ua_public));

        let message = encrypt(&ua_public, &auth, br#"{"title":"Hi"}"#).unwrap();
        let secret = agreement::agree_ephemeral(
            receiver,
            &agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, sender_key(&message)),
            <[u8]>::to_vec,
        )
        .unwrap();
        assert_eq!(
            decrypt_with(&secret, &ua_public, &auth, &message),
            br#"{"title":"Hi"}"#
        );
        assert!(encrypt(&ua_public, &auth, &vec![b'x'; MAX_PLAINTEXT + 1]).is_err());
    }

    /// Push services need only accept 4096-byte messages (RFC 8030, section 7.2), header
    /// included (RFC 8291, section 4).
    #[test]
    fn the_longest_message_fits_in_4096_bytes() {
        let rng = SystemRandom::new();
        let receiver =
            agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).unwrap();
        let ua_public: [u8; P256DH_LEN] = receiver
            .compute_public_key()
            .unwrap()
            .as_ref()
            .try_into()
            .unwrap();
        let message = encrypt(&ua_public, &[3; AUTH_LEN], &vec![b'x'; MAX_PLAINTEXT]).unwrap();
        assert_eq!(message.len(), 4096);
    }

    #[test]
    fn points_off_the_curve_are_not_keys() {
        let mut key = [1u8; P256DH_LEN];
        key[0] = 4;
        assert!(!is_valid_public_key(&key));
        assert!(encrypt(&key, &[0; AUTH_LEN], b"x").is_err());
    }

    #[test]
    fn the_vapid_key_is_kept_private_and_signs_tokens_for_its_public_key() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("push-key");
        let key = VapidKey::load_or_create(&path).unwrap();
        assert_eq!(key.public_key().len(), P256DH_LEN);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let again = VapidKey::load_or_create(&path).unwrap();
        assert_eq!(again.public_key(), key.public_key());

        let header = key.authorization("https://push.example", "mailto:me@example.com", 1234);
        let (token, k) = header
            .strip_prefix("vapid t=")
            .unwrap()
            .split_once(", k=")
            .unwrap();
        assert_eq!(d(k), key.public_key());
        let (signed, signature) = token.rsplit_once('.').unwrap();
        let claims: serde_json::Value =
            serde_json::from_slice(&d(signed.split_once('.').unwrap().1)).unwrap();
        assert_eq!(
            claims,
            serde_json::json!({ "aud": "https://push.example", "exp": 1234, "sub": "mailto:me@example.com" })
        );
        ring::signature::UnparsedPublicKey::new(
            &ring::signature::ECDSA_P256_SHA256_FIXED,
            key.public_key(),
        )
        .verify(signed.as_bytes(), &d(signature))
        .unwrap();
    }
}
