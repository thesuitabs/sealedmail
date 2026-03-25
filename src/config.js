// =============================================================================
// SealedMail MCP — config.js  (mainnet)
// Mirrors site/app/config.js — keep in sync when contract is upgraded.
// =============================================================================

export const CONFIG = {
    network: 'mainnet',
    rpcUrl:  'https://fullnode.mainnet.sui.io:443',

    packageId:        '0xadb04d8b84ec9afd8ee3ac2225dd77680b29e2d72f7c3e62bd4f1aa9593c4529',

    registryId:       '0x3fc28e1661873e6f3c080b74be6ad6893352ac7d92856237f016f0f7847cdf16',
    vaultId:          '0x3f8a1ad6051aee507292b2635b458154180680306ee0ce7a7c43d986cc3db8cb',
    treasuryId:       '0xfb49c8403c379ae4be189ba117c9332303ea02477fcc02c77326c5243035125c',

    protocolConfigId: '0xab303183c58cef6c81622e1195ee6666798599f1885d84939c8aabfeb2c14f3d',
    registryV2Id:     '0x1cb5f107ce63f878ffd9c3e6430a4ded74de717bf58f17935e598d8110ce83ec',

    walrusPublisher:     'https://publisher.walrus-mainnet.walrus.space',
    walrusAggregator:    'https://aggregator.walrus-mainnet.walrus.space',
    walrusStorageEpochs: 5,

    // Encryption disabled until SEAL mainnet key server is configured
    encryptionEnabled: false,
};
