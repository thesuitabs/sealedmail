#!/usr/bin/env node
// =============================================================================
// SealedMail MCP Server
// Exposes SealedMail send/receive as MCP tools so AI agents can use
// on-chain private messaging without a browser wallet.
//
// Usage:
//   SEALEDMAIL_PRIVATE_KEY=suiprivkey1... node src/index.js
// =============================================================================

import { McpServer }              from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport }   from '@modelcontextprotocol/sdk/server/stdio.js';
import { z }                      from 'zod';

import {
    initKeypair,
    getAddress,
    getSuiBalance,
    getInboxPrice,
    setInboxPrice,
    sendMessage,
    loadInbox,
    loadSent,
    readMessageBody,
} from './chain.js';

try {
    initKeypair();
} catch (err) {
    console.error('[SealedMail MCP] Failed to initialise keypair:', err.message);
    process.exit(1);
}

const server = new McpServer({ name: 'sealedmail', version: '0.1.1' });

server.tool('get_my_address', 'Returns the Sui address of this SealedMail agent.', {},
    async () => ({ content: [{ type: 'text', text: getAddress() }] })
);

server.tool('get_balance', 'Returns the SUI balance of the agent wallet in both MIST and SUI.', {},
    async () => {
        const { mist, sui } = await getSuiBalance(getAddress());
        return { content: [{ type: 'text', text: `Balance: ${sui.toFixed(6)} SUI (${mist} MIST)` }] };
    }
);

server.tool('get_inbox_price', 'Check how much SUI (in MIST) a recipient requires per message.',
    { address: z.string().describe('Sui address of the recipient (0x...)') },
    async ({ address }) => {
        const priceMist = await getInboxPrice(address);
        const priceSui  = priceMist / 1_000_000_000;
        const msg = priceMist === 0
            ? `${address} has no inbox price set — cannot receive SealedMail messages.`
            : `${address} charges ${priceSui.toFixed(6)} SUI (${priceMist} MIST) per message.`;
        return { content: [{ type: 'text', text: msg }] };
    }
);

server.tool('set_inbox_price', 'Set the minimum SUI payment required to receive messages. Min 0.001 SUI.',
    { price_sui: z.number().positive().describe('Price in SUI (e.g. 0.01)') },
    async ({ price_sui }) => {
        const priceMist = Math.round(price_sui * 1_000_000_000);
        if (priceMist < 1_000_000) throw new Error('Minimum inbox price is 0.001 SUI.');
        const result = await setInboxPrice(priceMist);
        return { content: [{ type: 'text', text: `Inbox price set to ${price_sui} SUI.\nTx: ${result.digest}` }] };
    }
);

server.tool('send_message', 'Send a message to a Sui address via SealedMail.',
    {
        recipient: z.string().describe('Recipient Sui address (0x...)'),
        subject:   z.string().describe('Message subject'),
        body:      z.string().describe('Message body'),
    },
    async ({ recipient, subject, body }) => {
        const { blobId, txResult, paymentMist } = await sendMessage({ recipient, subject, body });
        return { content: [{ type: 'text', text: `Sent.\nBlob: ${blobId}\nTx: ${txResult.digest}\nPaid: ${(paymentMist/1e9).toFixed(6)} SUI` }] };
    }
);

server.tool('read_inbox', 'List messages received by this agent.',
    { limit: z.number().int().min(1).max(50).default(10).describe('Max messages to return') },
    async ({ limit }) => {
        const messages = await loadInbox(getAddress(), limit);
        if (!messages.length) return { content: [{ type: 'text', text: 'Inbox is empty.' }] };
        const lines = messages.map((m, i) => `[${i+1}] From: ${m.sender}\n     Time: ${new Date(Number(m.timestamp)).toISOString()}\n     Blob: ${m.blobId}\n     Tx: ${m.txDigest}`);
        return { content: [{ type: 'text', text: `Inbox — ${messages.length} message(s):\n\n${lines.join('\n\n')}` }] };
    }
);

server.tool('read_sent', 'List messages sent by this agent.',
    { limit: z.number().int().min(1).max(50).default(10).describe('Max messages to return') },
    async ({ limit }) => {
        const messages = await loadSent(getAddress(), limit);
        if (!messages.length) return { content: [{ type: 'text', text: 'No sent messages.' }] };
        const lines = messages.map((m, i) => `[${i+1}] To: ${m.recipient}\n     Time: ${new Date(Number(m.timestamp)).toISOString()}\n     Blob: ${m.blobId}\n     Tx: ${m.txDigest}`);
        return { content: [{ type: 'text', text: `Sent — ${messages.length} message(s):\n\n${lines.join('\n\n')}` }] };
    }
);

server.tool('read_message_body', 'Fetch the full content of a message from Walrus by blob ID.',
    { blob_id: z.string().describe('Walrus blob ID from read_inbox or read_sent') },
    async ({ blob_id }) => {
        const { subject, body, encrypted } = await readMessageBody(blob_id);
        return { content: [{ type: 'text', text: `Subject: ${subject}\nEncrypted: ${encrypted}\n\n${body}` }] };
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[SealedMail MCP] Running — agent address:', getAddress());
