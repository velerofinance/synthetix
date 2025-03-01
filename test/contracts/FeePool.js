'use strict';

const { artifacts, contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const FeePool = artifacts.require('FeePool');
const FlexibleStorage = artifacts.require('FlexibleStorage');

const { fastForward, toUnit, toBN, fromUnit, multiplyDecimal } = require('../utils')();

const {
	ensureOnlyExpectedMutativeFunctions,
	setStatus,
	getDecodedLogs,
	decodedEventEqual,
	proxyThruTo,
	setExchangeFeeRateForSynths,
	setupPriceAggregators,
	updateAggregatorRates,
	onlyGivenAddressCanInvoke,
} = require('./helpers');

const { setupAllContracts } = require('./setup');

const { smockit } = require('@eth-optimism/smock');

const {
	toBytes32,
	defaults: { ISSUANCE_RATIO, FEE_PERIOD_DURATION, TARGET_THRESHOLD },
} = require('../..');

const CLAIM_AMOUNT_DELTA_TOLERATED = '50';

contract('FeePool', async accounts => {
	const [deployerAccount, owner, relayer, account1, account2] = accounts;

	// Updates rates with defaults so they're not stale.
	const updateRatesWithDefaults = async () => {
		await updateAggregatorRates(exchangeRates, [sAUD, SNX], ['0.5', '0.1'].map(toUnit));
		await debtCache.takeDebtSnapshot();
	};

	const closeFeePeriod = async () => {
		const feePeriodDuration = await feePool.feePeriodDuration();
		await fastForward(feePeriodDuration);
		await feePool.closeCurrentFeePeriod({ from: account1 });
		await updateRatesWithDefaults();
	};

	async function getFeesAvailable(account, key) {
		const result = await feePool.feesAvailable(account, key);
		return result[0];
	}

	const exchangeFeeRate = toUnit('0.006'); // 30 bips, applied on each synth
	const amountReceivedFromExchange = amountToExchange => {
		return multiplyDecimal(amountToExchange, toUnit('1').sub(exchangeFeeRate));
	};

	// CURRENCIES
	const [sUSD, sAUD, SNX] = ['sUSD', 'sAUD', 'SNX'].map(toBytes32);

	let feePool,
		debtCache,
		feePoolProxy,
		FEE_ADDRESS,
		synthetix,
		synthetixProxy,
		systemStatus,
		systemSettings,
		exchangeRates,
		rewardsDistribution,
		delegateApprovals,
		sUSDContract,
		addressResolver,
		wrapperFactory,
		aggregatorDebtRatio,
		synthetixBridgeToOptimism,
		synths;

	before(async () => {
		synths = ['sUSD', 'sAUD'];
		({
			AddressResolver: addressResolver,
			DelegateApprovals: delegateApprovals,
			ExchangeRates: exchangeRates,
			FeePool: feePool,
			DebtCache: debtCache,
			ProxyFeePool: feePoolProxy,
			RewardsDistribution: rewardsDistribution,
			Synthetix: synthetix,
			ProxyERC20Synthetix: synthetixProxy,
			SystemSettings: systemSettings,
			SynthsUSD: sUSDContract,
			SystemStatus: systemStatus,
			WrapperFactory: wrapperFactory,
			'ext:AggregatorDebtRatio': aggregatorDebtRatio,
		} = await setupAllContracts({
			accounts,
			synths,
			contracts: [
				'ExchangeRates',
				'Exchanger',
				'FeePool',
				'FeePoolEternalStorage',
				'DebtCache',
				'LiquidatorRewards',
				'Proxy',
				'Synthetix',
				'SystemSettings',
				'SystemStatus',
				'RewardEscrowV2',
				'RewardsDistribution',
				'DelegateApprovals',
				'CollateralManager',
				'OneNetAggregatorIssuedSynths',
				'OneNetAggregatorDebtRatio',
				'WrapperFactory',
			],
		}));

		// use implementation ABI on the proxy address to simplify calling
		synthetix = await artifacts.require('Synthetix').at(synthetixProxy.address);

		await setupPriceAggregators(exchangeRates, owner, [sAUD]);

		FEE_ADDRESS = await feePool.FEE_ADDRESS();

		synthetixBridgeToOptimism = await smockit(artifacts.require('SynthetixBridgeToOptimism').abi);

		// import special address for relayer so we can call as it
		await addressResolver.importAddresses(
			['SynthetixBridgeToOptimism', 'SynthetixBridgeToBase'].map(toBytes32),
			[synthetixBridgeToOptimism.address, relayer],
			{
				from: owner,
			}
		);

		await feePool.rebuildCache();
	});

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		// Send a price update to guarantee we're not stale.
		await updateRatesWithDefaults();

		// set a 0.3% default exchange fee rate                                                                                 │        { contract: 'ExchangeState' },
		const exchangeFeeRate = toUnit('0.003');
		const synthKeys = [sAUD, sUSD];
		await setExchangeFeeRateForSynths({
			owner,
			systemSettings,
			synthKeys,
			exchangeFeeRates: synthKeys.map(() => exchangeFeeRate),
		});
	});

	it('ensure only known functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: feePool.abi,
			ignoreParents: ['Proxyable', 'LimitedSetup', 'MixinResolver'],
			expected: [
				'recordFeePaid',
				'setRewardsToDistribute',
				'closeCurrentFeePeriod',
				'closeSecondary',
				'claimFees',
				'claimOnBehalf',
				'importFeePeriod',
			],
		});
	});

	it('should set constructor params on deployment', async () => {
		FeePool.link(await artifacts.require('SafeDecimalMath').new());
		const instance = await FeePool.new(
			account1, // proxy
			account2, // owner
			addressResolver.address, // resolver
			{
				from: deployerAccount,
			}
		);

		assert.equal(await instance.proxy(), account1);
		assert.equal(await instance.owner(), account2);
		assert.equal(await instance.resolver(), addressResolver.address);

		// Assert that our first period is open.
		assert.deepEqual(await instance.recentFeePeriods(0), {
			feePeriodId: 1,
			feesToDistribute: 0,
			feesClaimed: 0,
		});

		// And that the second period is not yet open
		assert.deepEqual(await instance.recentFeePeriods(1), {
			feePeriodId: 0,
			startTime: 0,
			feesToDistribute: 0,
			feesClaimed: 0,
		});
	});

	it('issuance ratio is correctly configured as a default', async () => {
		assert.bnEqual(await feePool.issuanceRatio(), ISSUANCE_RATIO);
	});

	it('the default is set correctly', async () => {
		assert.bnEqual(await feePool.targetThreshold(), toUnit(TARGET_THRESHOLD / 100));
	});

	it('fee period duration is correctly configured as a default', async () => {
		assert.bnEqual(await feePool.feePeriodDuration(), FEE_PERIOD_DURATION);
	});

	describe('restricted methods', () => {
		before(async () => {
			await proxyThruTo({
				proxy: feePoolProxy,
				target: feePool,
				fncName: 'setMessageSender',
				from: account1,
				args: [rewardsDistribution.address],
			});
		});
		it('setRewardsToDistribute() cannot be called by an unauthorized account', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: feePool.setRewardsToDistribute,
				accounts,
				args: ['0'],
				reason: 'RewardsDistribution only',
			});
		});
	});

	describe('when the issuanceRatio is 0.2', () => {
		beforeEach(async () => {
			// set default issuance ratio of 0.2
			await systemSettings.setIssuanceRatio(toUnit('0.2'), { from: owner });
		});

		it('should track fee withdrawals correctly', async () => {
			const amount = toUnit('10000');

			// Issue sUSD for two different accounts.
			await synthetix.transfer(account1, toUnit('1000000'), {
				from: owner,
			});

			await synthetix.issueSynths(amount, { from: owner });
			await synthetix.issueSynths(amount, { from: account1 });

			await closeFeePeriod();

			// Generate a fee.
			const exchange = toUnit('10000');
			await synthetix.exchange(sUSD, exchange, sAUD, { from: owner });

			await closeFeePeriod();

			// Then claim the owner's fees
			await feePool.claimFees({ from: owner });

			// At this stage there should be a single pending period, one that's half claimed, and an empty one.
			const length = (await feePool.FEE_PERIOD_LENGTH()).toNumber();
			const feeInUSD = exchange.sub(amountReceivedFromExchange(exchange));

			// First period
			assert.deepInclude(await feePool.recentFeePeriods(0), {
				feesToDistribute: toBN(0),
				feesClaimed: toBN(0),
			});

			// Second period
			const secondPeriod = await feePool.recentFeePeriods(1);
			assert.bnEqual(secondPeriod.feesToDistribute, feeInUSD);
			assert.bnEqual(secondPeriod.feesClaimed, feeInUSD.divRound(web3.utils.toBN('2')));

			// Everything else should be zero
			for (let i = 3; i < length; i++) {
				assert.deepInclude(await feePool.recentFeePeriods(i), {
					feesToDistribute: toBN(0),
					feesClaimed: toBN(0),
				});
			}

			// And once we roll the periods forward enough we should be able to see the correct
			// roll over happening.
			for (let i = 0; i < length * 2; i++) {
				await closeFeePeriod();
			}

			// All periods except last should now be 0
			for (let i = 0; i < length - 1; i++) {
				assert.deepInclude(await feePool.recentFeePeriods(i), {
					feesToDistribute: toBN(0),
					feesClaimed: toBN(0),
				});
			}

			// Last period should have rolled over fees to distribute
			const lastPeriod = await feePool.recentFeePeriods(length - 1);
			assert.bnEqual(lastPeriod.feesToDistribute, toBN(feeInUSD.div(web3.utils.toBN('2'))));
			assert.bnEqual(lastPeriod.feesClaimed, toBN(0));
		});

		it('should correctly calculate the totalFeesAvailable for a single open period', async () => {
			const amount = toUnit('10000');
			const fee = amount.sub(amountReceivedFromExchange(amount));

			// Issue sUSD for two different accounts.
			await synthetix.transfer(account1, toUnit('1000000'), {
				from: owner,
			});

			await synthetix.issueSynths(amount, { from: owner });
			await synthetix.issueSynths(amount.mul(web3.utils.toBN('2')), { from: account1 });

			// Generate a fee.
			await synthetix.exchange(sUSD, amount, sAUD, { from: owner });

			// Should be no fees available yet because the period is still pending.
			assert.bnEqual(await feePool.totalFeesAvailable(), 0);

			// So close out the period
			await closeFeePeriod();

			// Now we should have some fees.
			assert.bnEqual(await feePool.totalFeesAvailable(), fee);
		});

		it('should correctly calculate the totalFeesAvailable for multiple periods', async () => {
			const amount1 = toUnit('10000');
			const amount2 = amount1.mul(web3.utils.toBN('2'));
			const fee1 = amount1.sub(amountReceivedFromExchange(amount1));

			// Issue sUSD for two different accounts.
			await synthetix.transfer(account1, toUnit('1000000'), {
				from: owner,
			});

			await synthetix.issueSynths(amount1, { from: owner });
			await synthetix.issueSynths(amount2, { from: account1 });

			// Generate a fee.
			await synthetix.exchange(sUSD, amount1, sAUD, { from: owner });

			// Should be no fees available yet because the period is still pending.
			assert.bnEqual(await feePool.totalFeesAvailable(), 0);

			// So close out the period
			await closeFeePeriod();

			// Now we should have some fees.
			assert.bnEqual(await feePool.totalFeesAvailable(), fee1);

			// Ok, and do it again but with account1's synths this time.
			const fee2 = amount2.sub(amountReceivedFromExchange(amount2));

			// Generate a fee.
			await synthetix.exchange(sUSD, amount2, sAUD, { from: account1 });

			// Should be only the previous fees available because the period is still pending.
			assert.bnEqual(await feePool.totalFeesAvailable(), fee1);

			// Close out the period
			await closeFeePeriod();

			// Now we should have both fees.
			assert.bnClose(await feePool.totalFeesAvailable(), fee1.add(fee2));
		});

		it('should correctly calculate the feesAvailable for a single user in an open period', async () => {
			const amount = toUnit('10000');
			const fee = amount.sub(amountReceivedFromExchange(amount));

			// Issue sUSD for two different accounts.
			await synthetix.transfer(account1, toUnit('1000000'), {
				from: owner,
			});

			await synthetix.issueSynths(amount, { from: owner });
			await synthetix.issueSynths(amount.mul(web3.utils.toBN('2')), { from: account1 });

			// Close out the period to allow both users to be part of the whole fee period.
			await closeFeePeriod();

			// Generate a fee.
			await synthetix.exchange(sUSD, amount, sAUD, { from: owner });

			// Should be no fees available yet because the period is still pending.
			let feesAvailable;
			feesAvailable = await feePool.feesAvailable(owner);
			assert.bnEqual(feesAvailable[0], 0);

			feesAvailable = await feePool.feesAvailable(account1);
			assert.bnEqual(feesAvailable[0], 0);

			feesAvailable = await feePool.feesAvailable(account2);
			assert.bnEqual(feesAvailable[0], 0);

			// Make the period no longer pending
			await closeFeePeriod();

			// Now we should have some fees.
			feesAvailable = await feePool.feesAvailable(owner);
			assert.bnClose(feesAvailable[0], fee.div(web3.utils.toBN('3')), CLAIM_AMOUNT_DELTA_TOLERATED);

			feesAvailable = await feePool.feesAvailable(account1);
			assert.bnClose(
				feesAvailable[0],
				fee.div(web3.utils.toBN('3')).mul(web3.utils.toBN('2')),
				CLAIM_AMOUNT_DELTA_TOLERATED
			);

			// But account2 shouldn't be entitled to anything.
			feesAvailable = await feePool.feesAvailable(account2);
			assert.bnEqual(feesAvailable[0], 0);
		});

		it('should correctly calculate the feesAvailable for a single user in multiple periods when fees are partially claimed', async () => {
			const oneThird = number => number.div(web3.utils.toBN('3'));
			const twoThirds = number => oneThird(number).mul(web3.utils.toBN('2'));

			const amount = toUnit('10000');
			const fee = amount.sub(amountReceivedFromExchange(amount));
			const FEE_PERIOD_LENGTH = await feePool.FEE_PERIOD_LENGTH();

			// Issue sUSD for two different accounts.
			await synthetix.transfer(account1, toUnit('1000000'), {
				from: owner,
			});

			await synthetix.issueSynths(amount, { from: owner });
			await synthetix.issueSynths(amount.mul(web3.utils.toBN('2')), { from: account1 });

			// Close out the period to allow both users to be part of the whole fee period.
			await closeFeePeriod();

			// Generate a fee.
			await synthetix.exchange(sUSD, amount, sAUD, { from: owner });

			let feesAvailable;
			// Should be no fees available yet because the period is still pending.
			feesAvailable = await feePool.feesAvailable(owner);
			assert.bnEqual(feesAvailable[0], 0);
			feesAvailable = await feePool.feesAvailable(account1);
			assert.bnEqual(feesAvailable[0], 0);
			feesAvailable = await feePool.feesAvailable(account2);
			assert.bnEqual(feesAvailable[0], 0);

			// Make the period no longer pending
			await closeFeePeriod();

			// Now we should have some fees.
			feesAvailable = await feePool.feesAvailable(owner);
			assert.bnClose(feesAvailable[0], oneThird(fee), CLAIM_AMOUNT_DELTA_TOLERATED);
			feesAvailable = await feePool.feesAvailable(account1);
			assert.bnClose(feesAvailable[0], twoThirds(fee), CLAIM_AMOUNT_DELTA_TOLERATED);

			// The owner decides to claim their fees.
			await feePool.claimFees({ from: owner });

			// account1 should still have the same amount of fees available.
			feesAvailable = await feePool.feesAvailable(account1);
			assert.bnClose(feesAvailable[0], twoThirds(fee), CLAIM_AMOUNT_DELTA_TOLERATED);

			// If we close the next FEE_PERIOD_LENGTH fee periods off without claiming, their
			// fee amount that was unclaimed will roll forward, but will get proportionally
			// redistributed to everyone.
			for (let i = 0; i < FEE_PERIOD_LENGTH; i++) {
				await closeFeePeriod();
			}

			feesAvailable = await feePool.feesAvailable(account1);
			assert.bnClose(feesAvailable[0], twoThirds(twoThirds(fee)), CLAIM_AMOUNT_DELTA_TOLERATED);

			// But once they claim they should have zero.
			await feePool.claimFees({ from: account1 });
			feesAvailable = await feePool.feesAvailable(account1);
			assert.bnEqual(feesAvailable[0], 0);
		});

		describe('when closing the fee period', () => {
			it('should allow account1 to close the current fee period', async () => {
				await fastForward(await feePool.feePeriodDuration());

				const lastFeePeriodId = (await feePool.recentFeePeriods(0)).feePeriodId;

				const transaction = await feePool.closeCurrentFeePeriod({ from: account1 });
				assert.eventEqual(transaction, 'FeePeriodClosed', { feePeriodId: 1 });

				// Assert that our first period is new.
				assert.bnNotEqual((await feePool.recentFeePeriods(0)).feePeriodId, lastFeePeriodId);

				// And that the second was the old one
				assert.bnEqual((await feePool.recentFeePeriods(1)).feePeriodId, lastFeePeriodId);

				// fast forward and close another fee Period
				await fastForward(await feePool.feePeriodDuration());

				const secondFeePeriodId = (await feePool.recentFeePeriods(0)).feePeriodId;

				const secondPeriodClose = await feePool.closeCurrentFeePeriod({ from: account1 });
				assert.eventEqual(secondPeriodClose, 'FeePeriodClosed', { feePeriodId: secondFeePeriodId });
			});
			it('should import feePeriods and close the current fee period correctly', async () => {
				// startTime for most recent period is mocked to start same time as the 2018-03-13T00:00:00 datetime
				const feePeriodsImport = [
					{
						// recentPeriod 0
						index: 0,
						feePeriodId: 22,
						startTime: 1520859600,
						feesToDistribute: '5800660797674490860',
						feesClaimed: '0',
						rewardsToDistribute: '0',
						rewardsClaimed: '0',
					},
					{
						// recentPeriod 1
						index: 1,
						feePeriodId: 21,
						startTime: 1520254800,
						feesToDistribute: '934419341128642893704',
						feesClaimed: '0',
						rewardsToDistribute: '1442107692307692307692307',
						rewardsClaimed: '0',
					},
				];

				// import fee period data
				for (const period of feePeriodsImport) {
					await feePool.importFeePeriod(
						period.index,
						period.feePeriodId,
						period.startTime,
						period.feesToDistribute,
						period.feesClaimed,
						period.rewardsToDistribute,
						period.rewardsClaimed,
						{ from: owner }
					);
				}

				await fastForward(await feePool.feePeriodDuration());

				const transaction = await feePool.closeCurrentFeePeriod({ from: account1 });
				assert.eventEqual(transaction, 'FeePeriodClosed', { feePeriodId: 22 });

				// Assert that our first period is new.
				assert.deepInclude(await feePool.recentFeePeriods(0), {
					feesToDistribute: toBN(0),
					feesClaimed: toBN(0),
				});

				// And that the second was the old one and fees and rewards rolled over
				const feesToDistribute1 = web3.utils.toBN(feePeriodsImport[0].feesToDistribute, 'wei'); // 5800660797674490860
				const feesToDistribute2 = web3.utils.toBN(feePeriodsImport[1].feesToDistribute, 'wei'); // 934419341128642893704
				const rolledOverFees = feesToDistribute1.add(feesToDistribute2); // 940220001926317384564
				assert.deepEqual(await feePool.recentFeePeriods(1), {
					feePeriodId: 22,
					startTime: 1520859600,
					feesToDistribute: rolledOverFees,
					feesClaimed: '0',
					rewardsToDistribute: '1442107692307692307692307',
					rewardsClaimed: '0',
				});
			});

			it('should allow the feePoolProxy to close feePeriod', async () => {
				await fastForward(await feePool.feePeriodDuration());

				const { tx: hash } = await proxyThruTo({
					proxy: feePoolProxy,
					target: feePool,
					fncName: 'closeCurrentFeePeriod',
					from: owner,
					args: [],
				});

				const logs = await getDecodedLogs({ hash, contracts: [feePool] });

				decodedEventEqual({
					log: logs[0],
					event: 'FeePeriodClosed',
					emittedFrom: feePoolProxy.address,
					args: ['1'],
				});

				// Assert that our first period is new.
				assert.deepInclude(await feePool.recentFeePeriods(0), {
					feesToDistribute: toBN(0),
					feesClaimed: toBN(0),
				});

				// And that the second was the old one
				assert.deepInclude(await feePool.recentFeePeriods(1), {
					feesToDistribute: toBN(0),
					feesClaimed: toBN(0),
				});
			});
			it('should correctly roll over unclaimed fees when closing fee periods', async () => {
				// Issue 10,000 sUSD.
				await synthetix.issueSynths(toUnit('10000'), { from: owner });

				// Users are only entitled to fees when they've participated in a fee period in its
				// entirety. Roll over the fee period so fees generated below count for owner.
				await closeFeePeriod();

				// Do a single transfer of all our synths to generate a fee.
				await sUSDContract.transfer(account1, toUnit('10000'), {
					from: owner,
				});

				// Assert that the correct fee is in the fee pool.
				const fee = await sUSDContract.balanceOf(FEE_ADDRESS);
				const pendingFees = await feePool.feesByPeriod(owner);
				assert.bnEqual(web3.utils.toBN(pendingFees[0][0]), fee);
			});

			it('should correctly close the current fee period when there are more than FEE_PERIOD_LENGTH periods', async () => {
				const length = await feePool.FEE_PERIOD_LENGTH();

				// Issue 10,000 sUSD.
				await synthetix.issueSynths(toUnit('10000'), { from: owner });

				// Users have to have minted before the close of period. Close that fee period
				// so that there won't be any fees in period. future fees are available.
				await closeFeePeriod();

				// Do a single transfer of all our synths to generate a fee.
				await sUSDContract.transfer(account1, toUnit('10000'), {
					from: owner,
				});

				// Assert that the correct fee is in the fee pool.
				const fee = await sUSDContract.balanceOf(FEE_ADDRESS);
				const pendingFees = await feePool.feesByPeriod(owner);

				assert.bnEqual(pendingFees[0][0], fee);

				// Now close FEE_PERIOD_LENGTH * 2 fee periods and assert that it is still in the last one.
				for (let i = 0; i < length * 2; i++) {
					await closeFeePeriod();
				}

				const feesByPeriod = await feePool.feesByPeriod(owner);

				// Should be no fees for any period
				for (const zeroFees of feesByPeriod.slice(0, length - 1)) {
					assert.bnEqual(zeroFees[0], 0);
				}

				// Except the last one
				assert.bnEqual(feesByPeriod[length - 1][0], fee);
			});

			it('should correctly close the current fee period when there is only one fee period open', async () => {
				// Assert all the IDs and values are 0.
				const length = (await feePool.FEE_PERIOD_LENGTH()).toNumber();

				for (let i = 0; i < length; i++) {
					const period = await feePool.recentFeePeriods(i);

					assert.bnEqual(period.feePeriodId, i === 0 ? 1 : 0);
					assert.bnEqual(period.feesToDistribute, 0);
					assert.bnEqual(period.feesClaimed, 0);
				}

				// Now create the first fee
				await synthetix.issueSynths(toUnit('10000'), { from: owner });
				await sUSDContract.transfer(account1, toUnit('10000'), {
					from: owner,
				});
				const fee = await sUSDContract.balanceOf(FEE_ADDRESS);

				const oldFeePeriodId = (await feePool.recentFeePeriods(0)).feePeriodId;

				// And walk it forward one fee period.
				await closeFeePeriod();

				// Assert that we have the correct state

				// First period
				const firstPeriod = await feePool.recentFeePeriods(0);

				assert.bnNotEqual(firstPeriod.feePeriodId, oldFeePeriodId);
				assert.bnEqual(firstPeriod.feesToDistribute, 0);
				assert.bnEqual(firstPeriod.feesClaimed, 0);

				// Second period
				const secondPeriod = await feePool.recentFeePeriods(1);

				assert.bnEqual(secondPeriod.feePeriodId, oldFeePeriodId);
				assert.bnEqual(secondPeriod.feesToDistribute, fee);
				assert.bnEqual(secondPeriod.feesClaimed, 0);

				// Everything else should be zero
				for (let i = 2; i < length; i++) {
					const period = await feePool.recentFeePeriods(i);

					assert.bnEqual(period.feePeriodId, 0);
					assert.bnEqual(period.feesToDistribute, 0);
					assert.bnEqual(period.feesClaimed, 0);
				}
			});

			it('should receive fees from WrapperFactory', async () => {
				// Close the current one so we know exactly what we're dealing with
				await closeFeePeriod();

				// Wrapper Factory collects 100 sUSD in fees
				const collectedFees = toUnit(100);
				await sUSDContract.issue(wrapperFactory.address, collectedFees);

				await closeFeePeriod();

				const period = await feePool.recentFeePeriods(1);
				assert.bnEqual(period.feesToDistribute, collectedFees);
			});
		});

		describe('closeCurrentFeePeriod()', () => {
			describe('fee period duration not set', () => {
				beforeEach(async () => {
					const storage = await FlexibleStorage.new(addressResolver.address, {
						from: deployerAccount,
					});

					// replace FlexibleStorage in resolver
					await addressResolver.importAddresses(
						['FlexibleStorage'].map(toBytes32),
						[storage.address],
						{
							from: owner,
						}
					);

					await feePool.rebuildCache();
				});
				it('when closeFeePeriod() is invoked, it reverts with Fee Period Duration not set', async () => {
					await assert.revert(
						feePool.closeCurrentFeePeriod({ from: owner }),
						'Fee Period Duration not set'
					);
				});
			});
			describe('suspension conditions', () => {
				['System', 'Issuance'].forEach(section => {
					describe(`when ${section} is suspended`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: true });
						});
						it('then calling closeCurrentFeePeriod() reverts', async () => {
							await assert.revert(closeFeePeriod(), 'Operation prohibited');
						});
						describe(`when ${section} is resumed`, () => {
							beforeEach(async () => {
								await setStatus({ owner, systemStatus, section, suspend: false });
							});
							it('then calling closeCurrentFeePeriod() succeeds', async () => {
								await closeFeePeriod();
							});
						});
					});
				});
			});

			it('should disallow closing the current fee period too early', async () => {
				// Close the current one so we know exactly what we're dealing with
				await closeFeePeriod();

				await assert.revert(
					feePool.closeCurrentFeePeriod({ from: account1 }),
					'Too early to close fee period'
				);
			});

			it('should allow closing the current fee period very late', async () => {
				// Close it 500 times later than prescribed by feePeriodDuration
				// which should still succeed.
				const feePeriodDuration = await feePool.feePeriodDuration();
				await fastForward(feePeriodDuration.mul(web3.utils.toBN('500')));
				await updateRatesWithDefaults();
				await feePool.closeCurrentFeePeriod({ from: account1 });
			});

			it('should trigger bridge to close period on other networks', async () => {
				await synthetix.issueSynths(toUnit(500), { from: owner });

				await fastForward(await feePool.feePeriodDuration());

				await feePool.closeCurrentFeePeriod({ from: account1 });

				assert.equal(synthetixBridgeToOptimism.smocked.closeFeePeriod.calls.length, 1);

				assert.equal(
					synthetixBridgeToOptimism.smocked.closeFeePeriod.calls[0][0].toString(),
					'500000000000000000000'
				);
				assert.equal(
					synthetixBridgeToOptimism.smocked.closeFeePeriod.calls[0][1].toString(),
					'500000000000000000000'
				);
			});
		});

		describe('closeSecondary()', () => {
			describe('failure modes', () => {
				it('does not work when not invoked by the relayer address', async () => {
					await onlyGivenAddressCanInvoke({
						fnc: feePool.closeSecondary,
						args: ['1', '2'],
						accounts,
						reason: 'Only valid relayer can call',
						address: relayer,
					});
				});
			});

			describe('fee period duration not set', () => {
				beforeEach(async () => {
					const storage = await FlexibleStorage.new(addressResolver.address, {
						from: deployerAccount,
					});

					// replace FlexibleStorage in resolver
					await addressResolver.importAddresses(
						['FlexibleStorage'].map(toBytes32),
						[storage.address],
						{
							from: owner,
						}
					);

					await feePool.rebuildCache();
				});
				it('when closeSecondary() is invoked, it succeeds with Fee Period Duration not set', async () => {
					await feePool.closeSecondary('1', '2', { from: relayer });
				});
			});
			describe('suspension conditions', () => {
				['System', 'Issuance'].forEach(section => {
					describe(`when ${section} is suspended`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: true });
						});
						it('then calling closeSecondary() succeeds', async () => {
							await feePool.closeSecondary('1', '2', { from: relayer });
						});
					});
				});
			});

			it('should allow account1 to close the current fee period', async () => {
				await fastForward(await feePool.feePeriodDuration());

				const lastFeePeriodId = (await feePool.recentFeePeriods(0)).feePeriodId;

				const transaction = await feePool.closeCurrentFeePeriod({ from: account1 });
				assert.eventEqual(transaction, 'FeePeriodClosed', { feePeriodId: 1 });

				// Assert that our first period is new.
				assert.bnNotEqual((await feePool.recentFeePeriods(0)).feePeriodId, lastFeePeriodId);

				// And that the second was the old one
				assert.bnEqual((await feePool.recentFeePeriods(1)).feePeriodId, lastFeePeriodId);

				// fast forward and close another fee Period
				await fastForward(await feePool.feePeriodDuration());

				const secondFeePeriodId = (await feePool.recentFeePeriods(0)).feePeriodId;

				const secondPeriodClose = await feePool.closeCurrentFeePeriod({ from: account1 });
				assert.eventEqual(secondPeriodClose, 'FeePeriodClosed', { feePeriodId: secondFeePeriodId });
			});
			it('should import feePeriods and close the current fee period correctly', async () => {
				// startTime for most recent period is mocked to start same time as the 2018-03-13T00:00:00 datetime
				const feePeriodsImport = [
					{
						// recentPeriod 0
						index: 0,
						feePeriodId: 22,
						startTime: 1520859600,
						feesToDistribute: '5800660797674490860',
						feesClaimed: '0',
						rewardsToDistribute: '0',
						rewardsClaimed: '0',
					},
					{
						// recentPeriod 1
						index: 1,
						feePeriodId: 21,
						startTime: 1520254800,
						feesToDistribute: '934419341128642893704',
						feesClaimed: '0',
						rewardsToDistribute: '1442107692307692307692307',
						rewardsClaimed: '0',
					},
				];

				// import fee period data
				for (const period of feePeriodsImport) {
					await feePool.importFeePeriod(
						period.index,
						period.feePeriodId,
						period.startTime,
						period.feesToDistribute,
						period.feesClaimed,
						period.rewardsToDistribute,
						period.rewardsClaimed,
						{ from: owner }
					);
				}

				await fastForward(await feePool.feePeriodDuration());

				const transaction = await feePool.closeCurrentFeePeriod({ from: account1 });
				assert.eventEqual(transaction, 'FeePeriodClosed', { feePeriodId: 22 });

				// Assert that our first period is new.
				assert.deepInclude(await feePool.recentFeePeriods(0), {
					feesToDistribute: toBN(0),
					feesClaimed: toBN(0),
				});

				// And that the second was the old one and fees and rewards rolled over
				const feesToDistribute1 = web3.utils.toBN(feePeriodsImport[0].feesToDistribute, 'wei'); // 5800660797674490860
				const feesToDistribute2 = web3.utils.toBN(feePeriodsImport[1].feesToDistribute, 'wei'); // 934419341128642893704
				const rolledOverFees = feesToDistribute1.add(feesToDistribute2); // 940220001926317384564
				assert.deepEqual(await feePool.recentFeePeriods(1), {
					feePeriodId: 22,
					startTime: 1520859600,
					feesToDistribute: rolledOverFees,
					feesClaimed: '0',
					rewardsToDistribute: '1442107692307692307692307',
					rewardsClaimed: '0',
				});
			});

			it('should allow closing fee period even if its too early', async () => {
				// Close the current one so we know exactly what we're dealing with
				await closeFeePeriod();

				// Try to close the new fee period immediately again
				await feePool.closeSecondary('1', '2', { from: relayer });
			});

			it('should allow closing the current fee period very late', async () => {
				// Close it 500 times later than prescribed by feePeriodDuration
				// which should still succeed.
				const feePeriodDuration = await feePool.feePeriodDuration();
				await fastForward(feePeriodDuration.mul(web3.utils.toBN('500')));
				await updateRatesWithDefaults();
				await feePool.closeSecondary('1', '2', { from: relayer });
			});
		});

		describe('claimFees()', () => {
			describe('potential blocking conditions', () => {
				beforeEach(async () => {
					// ensure claimFees() can succeed by default (generate fees and close period)
					await synthetix.issueSynths(toUnit('10000'), { from: owner });
					await synthetix.exchange(sUSD, toUnit('10'), sAUD, { from: owner });
					await closeFeePeriod();
				});
				['System', 'Issuance'].forEach(section => {
					describe(`when ${section} is suspended`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: true });
						});
						it('then calling claimFees() reverts', async () => {
							await assert.revert(feePool.claimFees({ from: owner }), 'Operation prohibited');
						});
						describe(`when ${section} is resumed`, () => {
							beforeEach(async () => {
								await setStatus({ owner, systemStatus, section, suspend: false });
							});
							it('then calling claimFees() succeeds', async () => {
								await feePool.claimFees({ from: owner });
							});
						});
					});
				});
				describe(`when SNX is stale`, () => {
					beforeEach(async () => {
						await fastForward((await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300')));
						await debtCache.takeDebtSnapshot();
					});

					it('reverts on claimFees', async () => {
						await assert.revert(
							feePool.claimFees({ from: owner }),
							'A synth or SNX rate is invalid'
						);
					});
				});

				describe(`when debt aggregator is stale`, () => {
					beforeEach(async () => {
						await aggregatorDebtRatio.setOverrideTimestamp(500);
					});

					it('reverts on claimFees', async () => {
						await assert.revert(
							feePool.claimFees({ from: owner }),
							'A synth or SNX rate is invalid'
						);
					});
				});
			});

			it('should allow a user to claim their fees in sUSD @gasprofile', async () => {
				const length = (await feePool.FEE_PERIOD_LENGTH()).toNumber();

				// Issue 10,000 sUSD for two different accounts.
				await synthetix.transfer(account1, toUnit('1000000'), {
					from: owner,
				});

				await synthetix.issueSynths(toUnit('10000'), { from: owner });
				await synthetix.issueSynths(toUnit('10000'), { from: account1 });

				// For each fee period (with one extra to test rollover), do two exchange transfers, then close it off.
				for (let i = 0; i <= length; i++) {
					const exchange1 = toUnit(((i + 1) * 10).toString());
					const exchange2 = toUnit(((i + 1) * 15).toString());

					await synthetix.exchange(sUSD, exchange1, sAUD, { from: owner });
					await synthetix.exchange(sUSD, exchange2, sAUD, { from: account1 });

					await closeFeePeriod();
				}

				// Assert that we have correct values in the fee pool
				const feesAvailableUSD = await feePool.feesAvailable(owner);
				const oldsUSDBalance = await sUSDContract.balanceOf(owner);

				// Now we should be able to claim them.
				const claimFeesTx = await feePool.claimFees({ from: owner });

				assert.eventEqual(claimFeesTx, 'FeesClaimed', {
					sUSDAmount: feesAvailableUSD[0],
					snxRewards: feesAvailableUSD[1],
				});

				const newUSDBalance = await sUSDContract.balanceOf(owner);
				// We should have our fees
				assert.bnEqual(newUSDBalance, oldsUSDBalance.add(feesAvailableUSD[0]));
			});

			it('should allow a user to claim their fees in sUSD after burning @gasprofile', async () => {
				// Issue 10,000 sUSD for two different accounts.
				await synthetix.transfer(account1, toUnit('1000000'), {
					from: owner,
				});

				await synthetix.issueSynths(toUnit('10000'), { from: owner });
				await synthetix.issueSynths(toUnit('10000'), { from: account1 });

				await synthetix.exchange(sUSD, toUnit(100), sAUD, { from: account1 });

				await closeFeePeriod();

				// Settle our debt
				await synthetix.burnSynths(toUnit('999999'), { from: owner });

				assert.bnEqual(
					await synthetix.debtBalanceOf(owner, toBytes32('sUSD')),
					toUnit('0'),
					'account has debt remaining'
				);

				// Assert that we have correct values in the fee pool
				const feesAvailableUSD = await feePool.feesAvailable(owner);
				const oldsUSDBalance = await sUSDContract.balanceOf(owner);

				// Now we should be able to claim them.
				const claimFeesTx = await feePool.claimFees({ from: owner });

				assert.eventEqual(claimFeesTx, 'FeesClaimed', {
					sUSDAmount: feesAvailableUSD[0],
					snxRewards: feesAvailableUSD[1],
				});

				const newUSDBalance = await sUSDContract.balanceOf(owner);
				// We should have our fees
				assert.bnEqual(newUSDBalance, oldsUSDBalance.add(feesAvailableUSD[0]));
			});

			it('should allow a user to claim their fees if they minted debt during period', async () => {
				// Issue 10,000 sUSD for two different accounts.
				await synthetix.transfer(account1, toUnit('1000000'), {
					from: owner,
				});

				await synthetix.issueSynths(toUnit('10000'), { from: owner });

				// For first fee period, do two transfers, then close it off.
				let totalFees = web3.utils.toBN('0');

				const exchange1 = toUnit((10).toString());

				await synthetix.exchange(sUSD, exchange1, sAUD, { from: owner });

				totalFees = totalFees.add(exchange1.sub(amountReceivedFromExchange(exchange1)));

				await closeFeePeriod();

				// Assert that we have correct values in the fee pool
				// Owner should have all fees as only minted during period
				const feesAvailable = await feePool.feesAvailable(owner);
				assert.bnClose(feesAvailable[0], totalFees, '8');

				const oldSynthBalance = await sUSDContract.balanceOf(owner);

				// Now we should be able to claim them.
				await feePool.claimFees({ from: owner });

				// We should have our fees
				assert.bnEqual(await sUSDContract.balanceOf(owner), oldSynthBalance.add(feesAvailable[0]));

				// FeePeriod 2 - account 1 joins and mints 50% of the debt
				totalFees = web3.utils.toBN('0');
				await synthetix.issueSynths(toUnit('10000'), { from: account1 });

				// Generate fees
				await synthetix.exchange(sUSD, exchange1, sAUD, { from: owner });
				totalFees = totalFees.add(exchange1.sub(amountReceivedFromExchange(exchange1)));

				await closeFeePeriod();

				const feesAvailableOwner = await feePool.feesAvailable(owner);
				const feesAvailableAcc1 = await feePool.feesAvailable(account1);

				await feePool.claimFees({ from: account1 });

				assert.bnClose(feesAvailableOwner[0], totalFees.div(web3.utils.toBN('2')), '8');
				assert.bnClose(feesAvailableAcc1[0], totalFees.div(web3.utils.toBN('2')), '8');
			});

			it('should allow a user to claim their fees in sUSD (as half of total) after some exchanging', async () => {
				const length = (await feePool.FEE_PERIOD_LENGTH()).toNumber();

				// Issue 10,000 sUSD for two different accounts.
				await synthetix.transfer(account1, toUnit('1000000'), {
					from: owner,
				});

				await synthetix.issueSynths(toUnit('10000'), { from: owner });
				await synthetix.issueSynths(toUnit('10000'), { from: account1 });

				// For each fee period (with one extra to test rollover), do two transfers, then close it off.
				let totalFees = web3.utils.toBN('0');

				for (let i = 0; i <= length; i++) {
					const exchange1 = toUnit(((i + 1) * 10).toString());
					const exchange2 = toUnit(((i + 1) * 15).toString());

					await synthetix.exchange(sUSD, exchange1, sAUD, { from: owner });
					await synthetix.exchange(sUSD, exchange2, sAUD, { from: account1 });

					totalFees = totalFees.add(exchange1.sub(amountReceivedFromExchange(exchange1)));
					totalFees = totalFees.add(exchange2.sub(amountReceivedFromExchange(exchange2)));

					await closeFeePeriod();
				}

				// Period One checks
				const ownerDebtRatioForPeriod = await feePool.effectiveDebtRatioForPeriod(owner, 1);
				const account1DebtRatioForPeriod = await feePool.effectiveDebtRatioForPeriod(account1, 1);

				assert.bnEqual(ownerDebtRatioForPeriod, toUnit('0.5'));
				assert.bnEqual(account1DebtRatioForPeriod, toUnit('0.5'));

				// Assert that we have correct values in the fee pool
				const feesAvailable = await feePool.feesAvailable(owner);

				const half = amount => amount.div(web3.utils.toBN('2'));

				// owner has half the debt so entitled to half the fees
				assert.bnClose(feesAvailable[0], half(totalFees), '19');

				const oldSynthBalance = await sUSDContract.balanceOf(owner);

				// Now we should be able to claim them.
				await feePool.claimFees({ from: owner });

				// We should have our fees
				assert.bnEqual(await sUSDContract.balanceOf(owner), oldSynthBalance.add(feesAvailable[0]));
			});

			it('should revert when a user tries to double claim their fees', async () => {
				// Issue 10,000 sUSD.
				await synthetix.issueSynths(toUnit('10000'), { from: owner });

				// Users are only allowed to claim fees in periods they had an issued balance
				// for the entire period.
				await closeFeePeriod();

				// Do a single exchange of all our synths to generate a fee.
				const exchange1 = toUnit(100);
				await synthetix.exchange(sUSD, exchange1, sAUD, { from: owner });

				// Assert that the correct fee is in the fee pool.
				const fee = await sUSDContract.balanceOf(FEE_ADDRESS);
				const pendingFees = await feePool.feesByPeriod(owner);

				assert.bnEqual(pendingFees[0][0], fee);

				// Claiming should revert because the fee period is still open
				await assert.revert(
					feePool.claimFees({ from: owner }),
					'No fees or rewards available for period, or fees already claimed'
				);

				await closeFeePeriod();

				// Then claim them
				await feePool.claimFees({ from: owner });

				// But claiming again should revert
				const feesAvailable = await feePool.feesAvailable(owner);
				assert.bnEqual(feesAvailable[0], '0');

				await assert.revert(
					feePool.claimFees({ from: owner }),
					'No fees or rewards available for period, or fees already claimed'
				);
			});

			it('should revert when a user has no fees to claim but tries to claim them', async () => {
				await assert.revert(
					feePool.claimFees({ from: owner }),
					'No fees or rewards available for period, or fees already claimed'
				);
			});
		});

		describe('FeeClaimablePenaltyThreshold', async () => {
			it('should set the targetThreshold and getPenaltyThresholdRatio returns the c-ratio user is blocked at', async () => {
				const thresholdPercent = 10;

				await systemSettings.setTargetThreshold(thresholdPercent, { from: owner });

				const issuanceRatio = await feePool.issuanceRatio();
				const penaltyThreshold = await feePool.targetThreshold();

				assert.bnEqual(penaltyThreshold, toUnit(thresholdPercent / 100));

				// add the 10% buffer to the issuanceRatio to calculate penalty threshold would be at
				const expectedPenaltyThreshold = issuanceRatio.mul(toUnit('1').add(penaltyThreshold));

				assert.bnEqual(
					fromUnit(expectedPenaltyThreshold),
					await feePool.getPenaltyThresholdRatio()
				);
			});

			it('should set the targetThreshold buffer to 5%, at issuanceRatio 0.2 getPenaltyThresholdRatio returns 0.21', async () => {
				const thresholdPercent = 5;

				await systemSettings.setTargetThreshold(thresholdPercent, { from: owner });

				const issuanceRatio = await feePool.issuanceRatio();

				assert.bnEqual(issuanceRatio, toUnit('0.2'));

				const penaltyThreshold = await feePool.targetThreshold();

				assert.bnEqual(penaltyThreshold, toUnit(thresholdPercent / 100));

				// add the 5% buffer to the issuanceRatio to calculate penalty threshold would be at
				const expectedPenaltyThreshold = toUnit('0.21');

				assert.bnEqual(expectedPenaltyThreshold, await feePool.getPenaltyThresholdRatio());
			});

			it('should be no penalty if issuance ratio is less than target ratio', async () => {
				await synthetix.issueMaxSynths({ from: owner });

				// Increase the price so we start well and truly within our 20% ratio.
				const newRate = (await exchangeRates.rateForCurrency(SNX)).add(web3.utils.toBN('1'));
				await updateAggregatorRates(exchangeRates, [SNX], [newRate]);
				await debtCache.takeDebtSnapshot();

				assert.equal(await feePool.isFeesClaimable(owner), true);
			});

			it('should correctly calculate the 10% buffer for penalties at specific issuance ratios', async () => {
				const step = toUnit('0.01');
				await synthetix.issueMaxSynths({ from: owner });

				// Increase the price so we start well and truly within our 20% ratio.
				const newRate = (await exchangeRates.rateForCurrency(SNX)).add(
					step.mul(web3.utils.toBN('1'))
				);
				await updateAggregatorRates(exchangeRates, [SNX], [newRate]);
				await debtCache.takeDebtSnapshot();

				const issuanceRatio = fromUnit(await feePool.issuanceRatio());
				const penaltyThreshold = fromUnit(await feePool.targetThreshold());

				const threshold = Number(issuanceRatio) * (1 + Number(penaltyThreshold));
				// Start from the current price of synthetix and slowly decrease the price until
				// we hit almost zero. Assert the correct penalty at each point.
				while ((await exchangeRates.rateForCurrency(SNX)).gt(step.mul(web3.utils.toBN('2')))) {
					const ratio = await synthetix.collateralisationRatio(owner);

					if (ratio.lte(toUnit(threshold))) {
						// Should be claimable
						assert.equal(await feePool.isFeesClaimable(owner), true);
					} else {
						// Should be not claimable penalty
						assert.equal(await feePool.isFeesClaimable(owner), false);
					}

					// Bump the rate down.
					const newRate = (await exchangeRates.rateForCurrency(SNX)).sub(step);
					await updateAggregatorRates(exchangeRates, [SNX], [newRate]);
					await debtCache.takeDebtSnapshot();
				}
			});

			it('should revert when users try to claim fees with > 10% of threshold', async () => {
				// Issue 10,000 sUSD for two different accounts.
				await synthetix.transfer(account1, toUnit('1000000'), {
					from: owner,
				});

				await synthetix.issueMaxSynths({ from: account1 });
				const amount = await sUSDContract.balanceOf(account1);
				await synthetix.issueSynths(amount, { from: owner });
				await closeFeePeriod();

				// Do a transfer to generate fees
				await synthetix.exchange(sUSD, amount, sAUD, { from: owner });
				const fee = amount.sub(amountReceivedFromExchange(amount));

				// We should have zero fees available because the period is still open.
				assert.bnEqual(await getFeesAvailable(account1), 0);

				// Once the fee period is closed we should have half the fee available because we have
				// half the collateral backing up the system.
				await closeFeePeriod();
				assert.bnClose(await getFeesAvailable(account1), fee.div(web3.utils.toBN('2')));

				// But if the price of SNX decreases by 15%, we will lose all the fees.
				const currentRate = await exchangeRates.rateForCurrency(SNX);
				const newRate = currentRate.sub(multiplyDecimal(currentRate, toUnit('0.15')));

				await updateAggregatorRates(exchangeRates, [SNX], [newRate]);
				await debtCache.takeDebtSnapshot();

				// fees available is unaffected but not claimable
				assert.bnClose(await getFeesAvailable(account1), fee.div(web3.utils.toBN('2')));

				// And revert if we claim them
				await assert.revert(
					feePool.claimFees({ from: account1 }),
					'C-Ratio below penalty threshold'
				);
			});

			it('should be able to set the Target threshold to 15% and claim fees', async () => {
				// Issue 10,000 sUSD for two different accounts.
				await synthetix.transfer(account1, toUnit('1000000'), {
					from: owner,
				});

				await synthetix.issueMaxSynths({ from: account1 });
				const amount = await sUSDContract.balanceOf(account1);
				await synthetix.issueSynths(amount, { from: owner });
				await closeFeePeriod();

				// Do a transfer to generate fees
				await synthetix.exchange(sUSD, amount, sAUD, { from: owner });
				const fee = amount.sub(amountReceivedFromExchange(amount));

				// We should have zero fees available because the period is still open.
				assert.bnEqual(await getFeesAvailable(account1), 0);

				// Once the fee period is closed we should have half the fee available because we have
				// half the collateral backing up the system.
				await closeFeePeriod();
				assert.bnClose(await getFeesAvailable(account1), fee.div(web3.utils.toBN('2')));

				// But if the price of SNX decreases by 15%, we will lose all the fees.
				const currentRate = await exchangeRates.rateForCurrency(SNX);
				const newRate = currentRate.sub(multiplyDecimal(currentRate, toUnit('0.15')));

				await updateAggregatorRates(exchangeRates, [SNX], [newRate]);
				await debtCache.takeDebtSnapshot();

				// fees available is unaffected but not claimable
				assert.bnClose(await getFeesAvailable(account1), fee.div(web3.utils.toBN('2')));

				// And revert if we claim them
				await assert.revert(
					feePool.claimFees({ from: account1 }),
					'C-Ratio below penalty threshold'
				);

				// Should be able to set the Target threshold to 16% and now claim
				const newPercentage = 16;
				await systemSettings.setTargetThreshold(newPercentage, { from: owner });
				assert.bnEqual(await feePool.targetThreshold(), toUnit(newPercentage / 100));

				assert.equal(await feePool.isFeesClaimable(owner), true);
			});
		});

		describe('effectiveDebtRatioForPeriod', async () => {
			it('should return 0 if period is > than FEE_PERIOD_LENGTH', async () => {
				// returns length of periods
				const length = (await feePool.FEE_PERIOD_LENGTH()).toNumber();

				// adding an extra period should revert as not available (period rollsover at last one)
				await assert.bnEqual(await feePool.effectiveDebtRatioForPeriod(owner, length + 1), 0);
			});

			it('should return 0 if checking current unclosed period ', async () => {
				await assert.bnEqual(await feePool.effectiveDebtRatioForPeriod(owner, 0), 0);
			});
		});

		describe('claimOnBehalf', async () => {
			async function generateFees() {
				// Issue 10,000 sUSD.
				await synthetix.transfer(account1, toUnit('1000000'), {
					from: owner,
				});

				await synthetix.issueSynths(toUnit('10000'), { from: account1 });

				// For first fee period, do one exchange.
				const exchange1 = toUnit((10).toString());

				// generate fee
				await synthetix.exchange(sUSD, exchange1, sAUD, { from: account1 });

				await closeFeePeriod();
			}

			describe('potential blocking conditions', () => {
				const authoriser = account1;
				const delegate = account2;
				beforeEach(async () => {
					// approve account2 to claim on behalf of account1
					await delegateApprovals.approveClaimOnBehalf(delegate, { from: authoriser });
					// ensure claimFees() can succeed by default (generate fees and close period)
					await generateFees();
				});
				['System', 'Issuance'].forEach(section => {
					describe(`when ${section} is suspended`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: true });
						});
						it('then calling claimOnBehalf() reverts', async () => {
							await assert.revert(
								feePool.claimOnBehalf(authoriser, { from: delegate }),
								'Operation prohibited'
							);
						});
						describe(`when ${section} is resumed`, () => {
							beforeEach(async () => {
								await setStatus({ owner, systemStatus, section, suspend: false });
							});
							it('then calling claimOnBehalf() succeeds', async () => {
								await feePool.claimOnBehalf(authoriser, { from: delegate });
							});
						});
					});
				});
				describe(`when SNX is stale`, () => {
					beforeEach(async () => {
						await fastForward((await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300')));
						await debtCache.takeDebtSnapshot();
					});

					it('reverts on claimOnBehalf', async () => {
						await assert.revert(
							feePool.claimOnBehalf(authoriser, { from: delegate }),
							'A synth or SNX rate is invalid'
						);
					});
				});

				describe(`when debt aggregator is stale`, () => {
					beforeEach(async () => {
						await aggregatorDebtRatio.setOverrideTimestamp(500);
					});

					it('reverts on claimOnBehalf', async () => {
						await assert.revert(
							feePool.claimOnBehalf(authoriser, { from: delegate }),
							'A synth or SNX rate is invalid'
						);
					});
				});
			});

			it('should approve a claim on behalf for account1 by account2 and have fees in wallet', async () => {
				const authoriser = account1;
				const delegate = account2;

				// approve account2 to claim on behalf of account1
				await delegateApprovals.approveClaimOnBehalf(delegate, { from: authoriser });
				const result = await delegateApprovals.canClaimFor(authoriser, delegate);

				assert.isTrue(result);

				// Assert that we have correct values in the fee pool
				// account1 should have all fees as only minted during period
				await generateFees();

				const feesAvailable = await feePool.feesAvailable(account1);

				// old balance of account1 (authoriser)
				const oldSynthBalance = await sUSDContract.balanceOf(account1);

				// Now we should be able to claim them on behalf of account1.
				await feePool.claimOnBehalf(account1, { from: account2 });

				// We should have our fees for account1
				assert.bnEqual(
					await sUSDContract.balanceOf(account1),
					oldSynthBalance.add(feesAvailable[0])
				);
			});
			it('should revert if account2 tries to claimOnBehalf without approval', async () => {
				const authoriser = account1;
				const delegate = account2;

				// account2 doesn't have approval to claim on behalf of account1
				const result = await delegateApprovals.canClaimFor(authoriser, delegate);

				assert.isNotTrue(result);

				// Assert that we have correct values in the fee pool
				// account1 should have all fees as only minted during period
				await generateFees();

				await assert.revert(
					feePool.claimOnBehalf(account1, { from: account2 }),
					'Not approved to claim on behalf'
				);
			});
		});

		describe('reducing FEE_PERIOD_LENGTHS', async () => {
			it('should be able to get fees available when feePoolState issuanceData is 6 blocks', async () => {
				const length = (await feePool.FEE_PERIOD_LENGTH()).toNumber();

				await synthetix.transfer(account1, toUnit('1000000'), {
					from: owner,
				});

				// For each fee period (with one extra to test rollover), do two transfers, then close it off.
				let totalFees = web3.utils.toBN('0');

				// Iterate over the period lengths * 2 to fill up issuanceData in feePoolState
				// feePoolState can hold up to 6 periods of minting issuanceData
				// fee Periods can be less than the 6 periods
				for (let i = 0; i <= length * 2; i++) {
					const exchange1 = toUnit(((i + 1) * 10).toString());

					// Mint debt each period to fill up feelPoolState issuanceData to [6]
					await synthetix.issueSynths(toUnit('1000'), { from: owner });
					await synthetix.issueSynths(toUnit('1000'), { from: account1 });

					await synthetix.exchange(sUSD, exchange1, sAUD, { from: owner });

					totalFees = totalFees.add(exchange1.sub(amountReceivedFromExchange(exchange1)));

					await closeFeePeriod();
				}

				// Assert that we have correct values in the fee pool
				// Account1 should have all the fees as only account minted
				const feesAvailable = await feePool.feesAvailable(account1);
				assert.bnClose(feesAvailable[0], totalFees.div(web3.utils.toBN('2')), '8');

				const oldSynthBalance = await sUSDContract.balanceOf(account1);

				// Now we should be able to claim them.
				await feePool.claimFees({ from: account1 });

				// We should have our fees
				assert.bnEqual(
					await sUSDContract.balanceOf(account1),
					oldSynthBalance.add(feesAvailable[0])
				);
			});
		});
	});
});
