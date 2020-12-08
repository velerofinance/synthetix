'use strict';

const linker = require('solc/linker');
const Web3 = require('web3');
const { gray, green, yellow } = require('chalk');
const fs = require('fs');
const { getUsers } = require('../../index.js');
const { stringify, getEtherscanLinkPrefix } = require('./util');
const { getVersions } = require('../..');

class Deployer {
	/**
	 *
	 * @param {object} compiled An object with full combined contract name keys mapping to ABIs and bytecode
	 * @param {object} config An object with full combined contract name keys mapping to a deploy flag and the contract source file name
	 * @param {object} deployment An object with full combined contract name keys mapping to existing deployment addresses (if any)
	 */
	constructor({
		compiled,
		config,
		configFile,
		contractDeploymentGasLimit,
		deployment,
		deploymentFile,
		dryRun,
		gasPrice,
		methodCallGasLimit,
		network,
		providerUrl,
		privateKey,
		useFork,
		useOvm,
		ignoreSafetyChecks,
		nonceManager,
	}) {
		this.compiled = compiled;
		this.config = config;
		this.configFile = configFile;
		this.deployment = deployment;
		this.deploymentFile = deploymentFile;
		this.dryRun = dryRun;
		this.gasPrice = gasPrice;
		this.methodCallGasLimit = methodCallGasLimit;
		this.network = network;
		this.contractDeploymentGasLimit = contractDeploymentGasLimit;
		this.nonceManager = nonceManager;
		this.useOvm = useOvm;
		this.ignoreSafetyChecks = ignoreSafetyChecks;

		// Configure Web3 so we can sign transactions and connect to the network.
		this.web3 = new Web3(new Web3.providers.HttpProvider(providerUrl));

		if (useFork) {
			this.web3.eth.defaultAccount = getUsers({ network, user: 'owner' }).address; // protocolDAO
		} else if (!privateKey && network === 'local') {
			// Deterministic account #0 when using `npx buidler node`
			this.web3.eth.defaultAccount = '0xc783df8a850f42e7F7e57013759C285caa701eB6';
		} else {
			this.web3.eth.accounts.wallet.add(privateKey);
			this.web3.eth.defaultAccount = this.web3.eth.accounts.wallet[0].address;
		}
		this.account = this.web3.eth.defaultAccount;
		this.deployedContracts = {};
		this._dryRunCounter = 0;

		// Updated Config (Make a copy, don't mutate original)
		this.updatedConfig = JSON.parse(JSON.stringify(config));

		// Keep track of newly deployed contracts
		this.newContractsDeployed = [];
	}

	async sendParameters(type = 'method-call') {
		const params = {
			from: this.account,
			gas: type === 'method-call' ? this.methodCallGasLimit : this.contractDeploymentGasLimit,
			gasPrice: this.web3.utils.toWei(this.gasPrice, 'gwei'),
		};

		if (this.nonceManager) {
			params.nonce = await this.nonceManager.getNonce();
		}

		return params;
	}

	async _deploy({ name, source, args = [], deps = [], force = false, dryRun = this.dryRun }) {
		if (!this.config[name] && !force) {
			console.log(yellow(`Skipping ${name} as it is NOT in contract flags file for deployment.`));
			return;
		}
		const missingDeps = deps.filter(d => !this.deployedContracts[d] && !this.deployment.targets[d]);
		if (missingDeps.length) {
			throw Error(`Cannot deploy ${name} as it is missing dependencies: ${missingDeps.join(',')}`);
		}
		// by default, we deploy if force tells us to
		let deploy = force;
		// though use what's in the config if it exists
		if (this.config[name]) {
			deploy = this.config[name].deploy;
		}

		const compiled = this.compiled[source];

		if (!this.ignoreSafetyChecks) {
			const compilerVersion = compiled.metadata.compiler.version;
			const compiledForOvm = compiled.metadata.compiler.version.includes('ovm');
			const compilerMismatch = (this.useOvm && !compiledForOvm) || (!this.useOvm && compiledForOvm);
			if (compilerMismatch) {
				if (this.useOvm) {
					throw new Error(
						`You are deploying on Optimism, but the artifacts were not compiled for Optimism, using solc version ${compilerVersion} instead. Please use the correct compiler and try again.`
					);
				} else {
					throw new Error(
						`You are deploying on Ethereum, but the artifacts were compiled for Optimism, using solc version ${compilerVersion} instead. Please use the correct compiler and try again.`
					);
				}
			}
		}

		const existingAddress = this.deployment.targets[name]
			? this.deployment.targets[name].address
			: '';
		const existingABI = this.deployment.sources[source] ? this.deployment.sources[source].abi : '';

		if (!compiled) {
			throw new Error(
				`No compiled source for: ${name}. The source file is set to ${source}.sol - is that correct?`
			);
		}

		// Any contract after SafeDecimalMath can automatically get linked.
		// Doing this with bytecode that doesn't require the library is a no-op.
		let bytecode = compiled.evm.bytecode.object;
		['SafeDecimalMath', 'Math'].forEach(contractName => {
			if (this.deployedContracts[contractName]) {
				bytecode = linker.linkBytecode(bytecode, {
					[source + '.sol']: {
						[contractName]: this.deployedContracts[contractName].options.address,
					},
				});
			}
		});

		compiled.evm.bytecode.linkedObject = bytecode;

		let deployedContract;

		const areBytesSafeForOVM = bytes => {
			for (let i = 0; i < bytes.length; i+=2) {
  			const curByte = bytes.substr(i, 2)
  			const opNum = parseInt(curByte, 16)

  			// opNum is >=0x60 and <0x80
  			if(opNum >= 96 && opNum < 128) {
    			i += 2 * (opNum - 95) //For PUSH##, OpNum - 0x5f = ##
    			continue;
  			}

  			if(curByte === '5b') {
    			return false;
  			}

  			return true;
			}
		};

		const getEncodedDeploymentParameters = ({ abi, params }) => {
			let encodedParams = '0x';

			const constructorABI = abi.find(item => item.type === 'constructor');
			if (!constructorABI) {
				return encodedParams;
			}

			const inputs = constructorABI.inputs;
			if (!inputs || inputs.length === 0) {
				return encodedParams;
			}

			const types = inputs.map(input => input.type);
			return this.web3.eth.abi.encodeParameters(types, params);
		};

		if (deploy) {
			console.log(gray(` - Attempting to deploy ${name}`));
			let gasUsed;
			if (dryRun) {
				this._dryRunCounter++;
				// use the existing version of a contract in a dry run
				deployedContract = this.makeContract({ abi: compiled.abi, address: existingAddress });
				const { account } = this;
				// but stub out all method calls except owner because it is needed to
				// determine which actions can be performed directly or need to be added to ownerActions
				Object.keys(deployedContract.methods).forEach(key => {
					deployedContract.methods[key] = () => ({
						call: () => (key === 'owner' ? Promise.resolve(account) : undefined),
					});
				});
				deployedContract.options.address = '0x' + this._dryRunCounter.toString().padStart(40, '0');
			} else {
				const newContract = new this.web3.eth.Contract(compiled.abi);
				const deployTx = await newContract.deploy({
					data: '0x' + bytecode,
					arguments: args,
				});

				// Check if the deployment parameters are safe in OVM
				// (No need to check the metadata hash since its stripped with the OVM compiler)
				if (this.useOvm) {
					const encodedParameters = getEncodedDeploymentParameters({
						abi: compiled.abi,
						params: args,
					});
					if (!areBytesSafeForOVM(encodedParameters)) {
						throw new Error(
							`Attempting to deploy a contract with unsafe constructor parameters in OVM. Aborting. ${encodedParameters}`
						);
					}
				}

				deployedContract = await deployTx
					.send(await this.sendParameters('contract-deployment'))
					.on('receipt', receipt => (gasUsed = receipt.gasUsed));

				if (this.nonceManager) {
					this.nonceManager.incrementNonce();
				}
			}
			deployedContract.options.deployed = true; // indicate a fresh deployment occurred

			// Deployment in OVM could result in empty bytecode if
			// the contract's constructor parameters are unsafe.
			// This check is probably redundant given the previous check, but just in case...
			if (this.useOvm) {
				const code = await this.web3.eth.getCode(deployedContract.options.address);

				if (code.length === 2) {
					throw new Error('Contract deployment resulted in a contract with no bytecode');
				}
			}

			// If the resulting contract address is unsafe for OVM,
			// it is possible that the address may be used as a constructor parameter of
			// another contract. If it is unsafe, warn but don't fail.
			if (this.useOvm && !areBytesSafeForOVM(deployedContract.options.address)) {
				console.log(
					yellow(
						`⚠ WARNING: Deployed contract address ${deployedContract.options.address} contains unsafe opcodes for OVM. If it is used as a constructor argument in the deployment of another contract, it will make that deployment fail.`
					)
				);
			}

			console.log(
				green(
					`${dryRun ? '[DRY RUN] - Simulated deployment of' : '- Deployed'} ${name} to ${
						deployedContract.options.address
					} ${gasUsed ? `used ${(gasUsed / 1e6).toFixed(1)}m in gas` : ''}`
				)
			);
		} else if (existingAddress && existingABI) {
			// get ABI from the deployment (not the compiled ABI which may be newer)
			deployedContract = this.makeContract({ abi: existingABI, address: existingAddress });
			console.log(gray(` - Reusing instance of ${name} at ${existingAddress}`));
		} else {
			throw new Error(
				`Settings for contract: ${name} specify an existing contract, but cannot find address or ABI.`
			);
		}

		// append new deployedContract
		this.deployedContracts[name] = deployedContract;

		return deployedContract;
	}

	async _updateResults({ name, source, deployed, address }) {
		let timestamp = new Date();
		let txn = '';
		if (this.config[name] && !this.config[name].deploy) {
			// deploy is false, so we reused a deployment, thus lets grab the details that already exist
			timestamp = this.deployment.targets[name].timestamp;
			txn = this.deployment.targets[name].txn;
		}
		// now update the deployed contract information
		this.deployment.targets[name] = {
			name,
			address,
			source,
			link: `${getEtherscanLinkPrefix(this.network)}/address/${
				this.deployedContracts[name].options.address
			}`,
			timestamp,
			txn,
			network: this.network,
		};
		if (deployed) {
			// remove the output from the metadata (don't dupe the ABI)
			delete this.compiled[source].metadata.output;

			// track the new source and bytecode
			this.deployment.sources[source] = {
				bytecode: this.compiled[source].evm.bytecode.object,
				abi: this.compiled[source].abi,
				source: Object.values(this.compiled[source].metadata.sources)[0],
				metadata: this.compiled[source].metadata,
			};
			// add to the list of deployed contracts for later reporting
			this.newContractsDeployed.push({
				name,
				address,
			});
		}
		if (!this.dryRun) {
			fs.writeFileSync(this.deploymentFile, stringify(this.deployment));
		}

		// now update the flags to indicate it no longer needs deployment,
		// ignoring this step for local, which wants a full deployment by default
		if (this.configFile && this.network !== 'local' && !this.dryRun) {
			this.updatedConfig[name] = { deploy: false };
			fs.writeFileSync(this.configFile, stringify(this.updatedConfig));
		}
	}

	async deployContract({
		name,
		source = name,
		args = [],
		deps = [],
		force = false,
		dryRun = this.dryRun,
	}) {
		// Deploys contract according to configuration
		const deployedContract = await this._deploy({ name, source, args, deps, force, dryRun });

		if (!deployedContract) {
			return;
		}

		// Updates `config.json` and `deployment.json`, as well as to
		// the local variable newContractsDeployed
		await this._updateResults({
			name,
			source,
			deployed: deployedContract.options.deployed,
			address: deployedContract.options.address,
		});

		return deployedContract;
	}

	makeContract({ abi, address }) {
		return new this.web3.eth.Contract(abi, address);
	}

	getExistingContract({ contract }) {
		let address;
		if (this.network === 'local') {
			address = this.deployment.targets[contract].address;
		} else {
			const contractVersion = getVersions({
				network: this.network,
				useOvm: this.useOvm,
				byContract: true,
			})[contract];
			const lastEntry = contractVersion.slice(-1)[0];
			address = lastEntry.address;
		}

		const { source } = this.deployment.targets[contract];
		const { abi } = this.deployment.sources[source];
		return this.makeContract({ abi, address });
	}
}

module.exports = Deployer;
