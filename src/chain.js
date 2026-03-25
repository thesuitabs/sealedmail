// =============================================================================
// SealedMail MCP — chain.js
// Headless Node.js chain layer using Ed25519Keypair instead of browser wallet.
// Encryption is plaintext-only (matches current mainnet config).
// =============================================================================

import { SuiClient }        from '@mysten/sui/client';
import { Transaction }       from '@mysten/sui/transactions';
import { Ed25519Keypair }    from '@mysten/sui/keypairs/ed25519';
import { bcs }               from '@mysten/sui/bcs';
import { fromBase64 }        from '@mysten/sui/utils';

import { CONFIG } from './config.js';

let _keypair;

export function initKeypair() {
    const raw = process.env.SEALEDMAIL_PRIVATE_KEY;
    if (!raw) throw new Error(
        'SEALEDMAIL_PRIVATE_KEY is not set.\n' +
        'Export your key with: sui keytool export --key-identity <address>\n' +
        'Then set: export SEALEDMAIL_PRIVATE_KEY=suiprivkey1...'
    );
    _keypair = raw.startsWith('suiprivkey')
        ? Ed25519Keypair.fromSecretKey(raw)
        : Ed25519Keypair.fromSecretKey(fromBase64(raw));
    return _keypair;
}

export function getAddress() {
    if (!_keypair) initKeypair();
    return _keypair.getPublicKey().toSuiAddress();
}

export const suiClient = new SuiClient({ url: CONFIG.rpcUrl });

function encodeBlobIdForChain(blobIdStr) {
    const bytes = Array.from(new TextEncoder().encode(blobIdStr));
    return bcs.vector(bcs.u8()).serialize(bytes);
}

export function decodeBlobIdFromEvent(raw) {
    if (Array.isArray(raw)) return new TextDecoder().decode(new Uint8Array(raw));
    if (typeof raw === 'string') {
        if (raw.startsWith('0x')) {
            const hex = raw.slice(2);
            return new TextDecoder().decode(new Uint8Array(hex.match(/.{2}/g).map(h => parseInt(h, 16))));
        }
        try { return new TextDecoder().decode(Uint8Array.from(atob(raw), c => c.charCodeAt(0))); }
        catch { return raw; }
    }
    return '';
}

export async function walrusUpload(content) {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const url = `${CONFIG.walrusPublisher}/v1/blobs?epochs=${CONFIG.walrusStorageEpochs}`;
    const res = await fetch(url, { method: 'PUT', body: bytes });
    if (!res.ok) throw new Error(`Walrus upload failed: HTTP ${res.status}`);
    const json = await res.json();
    const blobId = json.newlyCreated?.blobObject?.blobId ?? json.alreadyCertified?.blobId;
    if (!blobId) throw new Error('Walrus upload: no blobId in response');
    return blobId;
}

export async function walrusDownload(blobId) {
    const url = `${CONFIG.walrusAggregator}/v1/blobs/${blobId}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Walrus download failed: HTTP ${res.status}`);
    return new TextDecoder().decode(await res.arrayBuffer());
}

async function signAndExecute(tx) {
    if (!_keypair) initKeypair();
    tx.setSender(getAddress());
    return suiClient.signAndExecuteTransaction({
        signer: _keypair, transaction: tx,
        options: { showEffects: true, showObjectChanges: false },
    });
}

export async function getInboxPrice(recipientAddress) {
    try {
        const tx = new Transaction();
        tx.moveCall({
            target: `${CONFIG.packageId}::protocol::get_inbox_price`,
            arguments: [tx.object(CONFIG.protocolConfigId), tx.pure.address(recipientAddress)],
        });
        const result = await suiClient.devInspectTransactionBlock({ transactionBlock: tx, sender: recipientAddress });
        const retVal = result?.results?.[0]?.returnValues?.[0];
        if (!retVal) return 0;
        const bytes = new Uint8Array(retVal[0]);
        let price = 0n;
        for (let i = 7; i >= 0; i--) price = (price << 8n) | BigInt(bytes[i]);
        return Number(price);
    } catch { return 0; }
}

export async function setInboxPrice(minPaymentMist) {
    const tx = new Transaction();
    tx.moveCall({
        target: `${CONFIG.packageId}::protocol::set_inbox_price`,
        arguments: [tx.object(CONFIG.protocolConfigId), tx.pure.u64(BigInt(minPaymentMist))],
    });
    return signAndExecute(tx);
}

export async function sendMessage({ recipient, subject, body }) {
    const inboxPrice = await getInboxPrice(recipient);
    if (!inboxPrice) throw new Error(`Recipient ${recipient.slice(0,10)}... has not set an inbox price.`);
    const envelope = JSON.stringify({ v: 2, subject, encrypted: false, body, attachments: [] });
    const blobId = await walrusUpload(envelope);
    const blobIdBcs = encodeBlobIdForChain(blobId);
    const tx = new Transaction();
    const [paymentCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(BigInt(inboxPrice))]);
    tx.moveCall({
        target: `${CONFIG.packageId}::protocol::send_message`,
        arguments: [
            tx.object(CONFIG.registryV2Id), tx.object(CONFIG.protocolConfigId),
            tx.pure.address(recipient), tx.pure(blobIdBcs),
            tx.pure.address(CONFIG.packageId), paymentCoin,
        ],
    });
    const txResult = await signAndExecute(tx);
    return { blobId, txResult, paymentMist: inboxPrice };
}

function parseV2Event(event) {
    const j = event.parsedJson ?? {};
    return { id: j.message_id ?? '?', sender: j.sender ?? '0x?', recipient: j.recipient ?? '0x?',
        blobId: decodeBlobIdFromEvent(j.blob_id), timestamp: j.timestamp ?? '?',
        paymentMist: j.payment ?? 0, txDigest: event.id?.txDigest ?? '', version: 2 };
}

function parseV1Event(event) {
    const j = event.parsedJson ?? {};
    return { id: j.message_id ?? '?', sender: j.sender ?? '0x?', recipient: j.recipient ?? '0x?',
        blobId: decodeBlobIdFromEvent(j.blob_id), timestamp: j.timestamp ?? '?',
        txDigest: event.id?.txDigest ?? '', version: 1 };
}

export async function loadInbox(address, limit = 20) {
    const [v2, v1] = await Promise.all([
        suiClient.queryEvents({ query: { MoveEventType: `${CONFIG.packageId}::protocol::MessageSentV2` }, order: 'descending', limit: 50 }),
        suiClient.queryEvents({ query: { MoveEventType: `${CONFIG.packageId}::core::MessageSent` }, order: 'descending', limit: 50 }),
    ]);
    return [...v2.data.filter(e => e.parsedJson?.recipient === address).map(parseV2Event),
            ...v1.data.filter(e => e.parsedJson?.recipient === address).map(parseV1Event)]
        .sort((a, b) => Number(b.timestamp) - Number(a.timestamp)).slice(0, limit);
}

export async function loadSent(address, limit = 20) {
    const [v2, v1] = await Promise.all([
        suiClient.queryEvents({ query: { MoveEventType: `${CONFIG.packageId}::protocol::MessageSentV2` }, order: 'descending', limit: 50 }),
        suiClient.queryEvents({ query: { MoveEventType: `${CONFIG.packageId}::core::MessageSent` }, order: 'descending', limit: 50 }),
    ]);
    return [...v2.data.filter(e => e.parsedJson?.sender === address).map(parseV2Event),
            ...v1.data.filter(e => e.parsedJson?.sender === address).map(parseV1Event)]
        .sort((a, b) => Number(b.timestamp) - Number(a.timestamp)).slice(0, limit);
}

export async function readMessageBody(blobId) {
    const raw = await walrusDownload(blobId);
    try {
        const parsed = JSON.parse(raw);
        return { subject: parsed.subject ?? '(no subject)', body: parsed.body ?? '(empty)',
            encrypted: parsed.encrypted ?? false, attachments: parsed.attachments ?? [], version: parsed.v ?? 1 };
    } catch {
        return { subject: '(legacy)', body: raw, encrypted: false, attachments: [], version: 1 };
    }
}

export async function getSuiBalance(address) {
    const balance = await suiClient.getBalance({ owner: address });
    return { mist: BigInt(balance.totalBalance), sui: Number(BigInt(balance.totalBalance)) / 1_000_000_000 };
}
