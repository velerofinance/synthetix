const fs = require('fs');
const path = require('path');
const ethers = require('ethers');
const { gray, red, yellow } = require('chalk');
const { wrap, toBytes32 } = require('../../..');
const { confirmAction } = require('../util');
const {
	ensureNetwork,
	ensureDeploymentPath,
	getDeploymentPathForNetwork,
	loadConnections,
} = require('../util');

const connectBridge = async ({
	l1Network,
	l2Network,
	l1ProviderUrl,
	l2ProviderUrl,
	l1DeploymentPath,
	l2DeploymentPath,
	l1PrivateKey,
	l2PrivateKey,
	l1UseFork,
	l2UseFork,
	l1Messenger,
	l2Messenger,
	dryRun,
	l1GasLimit,
	quiet,
}) => {
	const logger = console.log;
	if (quiet) {
		console.log = () => {};
	}

	// ---------------------------------
	// Setup L1 instance
	// ---------------------------------

	console.log(gray('* Setting up L1 instance...'));
	const {
		wallet: walletL1,
		AddressResolver: AddressResolverL1,
		SynthetixBridge: SynthetixBridgeToOptimism,
		Synthetix,
		BridgeEscrow: SynthetixBridgeEscrow,
		OwnerRelay: OwnerRelayOnEthereum,
	} = await setupInstance({
		network: l1Network,
		providerUrl: l1ProviderUrl,
		deploymentPath: l1DeploymentPath,
		privateKey: l1PrivateKey,
		useFork: l1UseFork,
		messenger: l1Messenger,
		useOvm: false,
	});

	// ---------------------------------
	// Setup L2 instance
	// ---------------------------------

	console.log(gray('* Setting up L2 instance...'));
	const {
		wallet: walletL2,
		AddressResolver: AddressResolverL2,
		SynthetixBridge: SynthetixBridgeToBase,
		OwnerRelay: OwnerRelayOnOptimism,
	} = await setupInstance({
		network: l2Network,
		providerUrl: l2ProviderUrl,
		deploymentPath: l2DeploymentPath,
		privateKey: l2PrivateKey,
		useFork: l2UseFork,
		messenger: l2Messenger,
		useOvm: true,
	});

	// ---------------------------------
	// Connect L1 instance
	// ---------------------------------

	console.log(gray('* Connecting bridge on L1...'));
	await connectLayer({
		wallet: walletL1,
		gasLimit: l1GasLimit,
		names: ['ext:Messenger', 'ovm:SynthetixBridgeToBase', 'ovm:OwnerRelayOnOptimism'],
		addresses: [l1Messenger, SynthetixBridgeToBase.address, OwnerRelayOnOptimism.address],
		AddressResolver: AddressResolverL1,
		cachables: [SynthetixBridgeToOptimism, OwnerRelayOnEthereum],
		dryRun,
	});

	// ---------------------------------
	// Connect L2 instance
	// ---------------------------------

	console.log(gray('* Connecting bridge on L2...'));
	await connectLayer({
		wallet: walletL2,
		gasLimit: undefined,
		names: ['ext:Messenger', 'base:SynthetixBridgeToOptimism', 'base:OwnerRelayOnEthereum'],
		addresses: [l2Messenger, SynthetixBridgeToOptimism.address, OwnerRelayOnEthereum.address],
		AddressResolver: AddressResolverL2,
		cachables: [SynthetixBridgeToBase, OwnerRelayOnOptimism],
		dryRun,
	});

	// check approval (bridge needs ERC20 approval to spend bridge escrow's SNX for withdrawals)
	const currentAllowance = await Synthetix.allowance(
		SynthetixBridgeEscrow.address,
		SynthetixBridgeToOptimism.address
	);

	console.log(
		gray(
			'Current allowance for bridge to spend bridge escrow SNX is',
			ethers.utils.formatEther(currentAllowance)
		)
	);

	if (currentAllowance.lt(ethers.utils.parseEther('100000000000'))) {
		// called when allowance is under 100 B

		console.log(yellow('The bridge does not have sufficient allowance.'));

		if (!dryRun) {
			console.log(
				yellow.inverse(
					`  * CALLING SynthetixBridgeEscrow.approveBridge(SNX, 'SynthetixBridgeToOptimism', UInt256.MAX))`
				)
			);
			const owner = await SynthetixBridgeEscrow.owner();
			if (walletL1.address.toLowerCase() !== owner.toLowerCase()) {
				const calldata = await SynthetixBridgeEscrow.interface.encodeFunctionData('approveBridge', [
					Synthetix.address,
					SynthetixBridgeToOptimism.address,
					ethers.constants.MaxUint256,
				]);
				console.log('Calldata is', calldata);
				await confirmAction(
					yellow(
						`    ⚠️  AddressResolver is owned by ${owner} and the current signer is ${walletL1.address}.
						Please execute the above transaction and press "y" when done.`
					)
				);
			} else {
				const params = {
					gasLimit: l1GasLimit,
				};
				const tx = await SynthetixBridgeEscrow.approveBridge(
					Synthetix.address,
					SynthetixBridgeToOptimism.address,
					ethers.constants.MaxUint256,
					params
				);
				const receipt = await tx.wait();
				console.log(gray(`    > tx hash: ${receipt.transactionHash}`));
			}
		} else {
			console.log(yellow('  * Skipping, since this is a DRY RUN'));
		}
	} else {
		console.log(gray('this is sufficient'));
	}

	console.log = logger;
};

const connectLayer = async ({
	wallet,
	gasLimit,
	names,
	addresses,
	AddressResolver,
	cachables,
	dryRun,
}) => {
	// ---------------------------------
	// Check if the AddressResolver has all the correct addresses
	// ---------------------------------

	const filteredNames = [];
	const filteredAddresses = [];
	for (let i = 0; i < names.length; i++) {
		const name = names[i];
		const address = addresses[i];
		console.log(gray(`  * Checking if ${name} is already set to ${address}`));

		const readAddress = await AddressResolver.getAddress(toBytes32(name));

		if (readAddress.toLowerCase() !== address.toLowerCase()) {
			console.log(yellow(`    > ${name} is not set, including it...`));
			filteredNames.push(name);
			filteredAddresses.push(address);
		}
	}

	const needToImportAddresses = filteredNames.length > 0;

	// ---------------------------------
	// Update AddressResolver if needed
	// ---------------------------------

	const params = {};
	if (gasLimit) {
		params.gasLimit = gasLimit;
	}

	let tx, receipt;

	if (needToImportAddresses) {
		const ids = names.map(toBytes32);

		console.log(yellow('  * Setting these values:'));
		names.map((_, idx) => console.log(yellow(`    > ${names[idx]} => ${addresses[idx]}`)));

		if (!dryRun) {
			console.log(
				yellow.inverse(`  * CALLING AddressResolver.importAddresses([${ids}], [${addresses}])`)
			);

			const owner = await AddressResolver.owner();
			if (wallet.address.toLowerCase() !== owner.toLowerCase()) {
				const calldata = await AddressResolver.interface.encodeFunctionData('importAddresses', [
					names.map(toBytes32),
					addresses,
				]);
				console.log('Calldata is', calldata);
				await confirmAction(
					yellow(
						`    ⚠️  AddressResolver is owned by ${owner} and the current signer is $${wallet.address}. Please execute the above transaction and press "y" when done.`
					)
				);
			} else {
				tx = await AddressResolver.importAddresses(names.map(toBytes32), addresses, params);
				receipt = await tx.wait();
				console.log(gray(`    > tx hash: ${receipt.transactionHash}`));
			}
		} else {
			console.log(yellow('  * Skipping, since this is a DRY RUN'));
		}
	} else {
		console.log(
			gray('  * Bridge does not need to import any addresses in this layer. Skipping...')
		);
	}

	// ---------------------------------
	// Sync cache on bridge if needed
	// ---------------------------------

	for (const contract of cachables) {
		const isCached = await contract.isResolverCached();
		if (!isCached) {
			if (!dryRun) {
				console.log(yellow.inverse(`  * CALLING rebuildCache() on ${contract.address}...`));

				tx = await contract.rebuildCache(params);
				receipt = await tx.wait();

				console.log(gray(`    > tx hash: ${receipt.transactionHash}`));
			} else {
				console.log(yellow('Skipping rebuildCache(), since this is a DRY RUN'));
			}
		}
	}
};

const setupInstance = async ({
	network,
	providerUrl: specifiedProviderUrl,
	deploymentPath,
	privateKey,
	useFork,
	useOvm,
}) => {
	console.log(gray('  > network:', network));
	console.log(gray('  > deploymentPath:', deploymentPath));
	console.log(gray('  > privateKey:', privateKey));
	console.log(gray('  > useFork:', useFork));
	console.log(gray('  > useOvm:', useOvm));

	const { wallet, provider, getSource, getTarget } = bootstrapConnection({
		network,
		providerUrl: specifiedProviderUrl,
		deploymentPath,
		privateKey,
		useFork,
		useOvm,
	});
	console.log(gray('  > provider:', provider.connection.url));
	console.log(gray('  > account:', wallet.address));

	const AddressResolver = getContract({
		contract: 'AddressResolver',
		getTarget,
		getSource,
		deploymentPath,
		wallet,
	});
	console.log(gray('  > AddressResolver:', AddressResolver.address));

	const bridgeName = useOvm ? 'SynthetixBridgeToBase' : 'SynthetixBridgeToOptimism';
	const SynthetixBridge = getContract({
		contract: bridgeName,
		getTarget,
		getSource,
		deploymentPath,
		wallet,
	});
	console.log(gray(`  > ${bridgeName}:`, SynthetixBridge.address));

	const relayName = useOvm ? 'OwnerRelayOnOptimism' : 'OwnerRelayOnEthereum';
	const OwnerRelay = getContract({
		contract: relayName,
		getTarget,
		getSource,
		deploymentPath,
		wallet,
	});
	console.log(gray(`  > ${relayName}:`, OwnerRelay.address));

	let Synthetix;
	let BridgeEscrow;

	if (!useOvm) {
		Synthetix = getContract({
			contract: 'ProxySynthetix',
			getTarget,
			getSource,
			sourceName: 'Synthetix',
			deploymentPath,
			wallet,
		});

		BridgeEscrow = getContract({
			contract: 'SynthetixBridgeEscrow',
			getTarget,
			getSource,
			deploymentPath,
			wallet,
		});
	}

	return {
		AddressResolver,
		BridgeEscrow,
		OwnerRelay,
		Synthetix,
		SynthetixBridge,
		wallet,
	};
};

const bootstrapConnection = ({
	network,
	providerUrl: specifiedProviderUrl,
	deploymentPath,
	privateKey,
	useFork,
	useOvm,
}) => {
	ensureNetwork(network);
	deploymentPath = deploymentPath || getDeploymentPathForNetwork({ network, useOvm });
	ensureDeploymentPath(deploymentPath);

	const { providerUrl: defaultProviderUrl, privateKey: envPrivateKey } = loadConnections({
		network,
		useFork,
	});

	// allow local deployments to use the private key passed as a CLI option
	if (network !== 'local' && !privateKey) {
		privateKey = envPrivateKey;
	}

	const providerUrl = specifiedProviderUrl || defaultProviderUrl;
	const provider = new ethers.providers.JsonRpcProvider(providerUrl);

	const { getUsers, getTarget, getSource } = wrap({ network, useOvm, fs, path });

	let wallet;
	if (!privateKey) {
		const account = getUsers({ network, user: 'owner' }).address;
		wallet = provider.getSigner(account);
		wallet.address = wallet._address;
	} else {
		wallet = new ethers.Wallet(privateKey, provider);
	}

	return {
		deploymentPath,
		providerUrl,
		privateKey,
		provider,
		wallet,
		getTarget,
		getSource,
		getUsers,
	};
};

const getContract = ({ contract, deploymentPath, getTarget, getSource, wallet, sourceName }) => {
	const target = getTarget({ deploymentPath, contract });
	if (!target) {
		throw new Error(`Unable to find deployed target for ${contract} in ${deploymentPath}`);
	}

	const source = getSource({ deploymentPath, contract: sourceName || contract });
	if (!source) {
		throw new Error(`Unable to find source for ${contract}`);
	}

	return new ethers.Contract(target.address, source.abi, wallet);
};

module.exports = {
	connectBridge,
	cmd: program =>
		program
			.command('connect-bridge')
			.description('Configures the bridge between an L1-L2 instance pair.')
			.option('--l1-network <value>', 'The name of the target L1 network', 'goerli')
			.option('--l2-network <value>', 'The name of the target L2 network', 'goerli')
			.option('--l1-provider-url <value>', 'The L1 provider to use', undefined)
			.option('--l2-provider-url <value>', 'The L2 provider to use', 'https://goerli.optimism.io')
			.option('--l1-deployment-path <value>', 'The path of the L1 deployment to target')
			.option('--l2-deployment-path <value>', 'The path of the L2 deployment to target')
			.option('--l1-private-key <value>', 'Optional private key for signing L1 transactions')
			.option('--l2-private-key <value>', 'Optional private key for signing L2 transactions')
			.option('--l1-use-fork', 'Wether to use a fork for the L1 connection', false)
			.option('--l2-use-fork', 'Wether to use a fork for the L2 connection', false)
			.option('--l1-messenger <value>', 'L1 cross domain messenger to use')
			.option('--l2-messenger <value>', 'L2 cross domain messenger to use')
			.option('--l1-gas-limit <value>', 'Max gas to use when signing transactions to l1', 8000000)
			.option('--dry-run', 'Do not execute any transactions')
			.option('--quiet', 'Do not print stdout', false)
			.action(async (...args) => {
				try {
					await connectBridge(...args);
				} catch (err) {
					console.error(red(err));
					console.log(err.stack);
					process.exitCode = 1;
				}
			}),
};
