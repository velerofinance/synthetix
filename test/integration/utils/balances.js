const ethers = require('ethers');
const { deposit } = require('./optimism');
const { toBytes32 } = require('../../..');

async function ensureBalance({ ctx, symbol, user, balance }) {
	const currentBalance = await _readBalance({ ctx, symbol, user });

	if (currentBalance.lt(balance)) {
		const amount = balance.sub(currentBalance);

		await _getAmount({ ctx, symbol, user, amount });
	}
}

async function _readBalance({ ctx, symbol, user }) {
	if (symbol !== 'ETH') {
		const token = _getTokenFromSymbol({ ctx, symbol });

		return token.balanceOf(user.address);
	} else {
		return ctx.provider.getBalance(user.address);
	}
}

async function _getAmount({ ctx, symbol, user, amount }) {
	if (symbol === 'SNX') {
		await _getSNX({ ctx, user, amount });
	} else if (symbol === 'WETH') {
		await _getWETH({ ctx, user, amount });
	} else if (symbol === 'sUSD') {
		await _getsUSD({ ctx, user, amount });
	} else if (symbol === 'sETH') {
		await _getSynth({ ctx, symbol, user, amount });
	} else if (symbol === 'ETH') {
		await _getETHFromOtherUsers({ ctx, user, amount });
	} else {
		throw new Error(
			`Symbol ${symbol} not yet supported. TODO: Support via exchanging sUSD to other Synths.`
		);
	}

	// sanity check
	const newBalance = await _readBalance({ ctx, symbol, user });
	if (newBalance.lt(amount)) {
		throw new Error(`Failed to get required ${amount} ${symbol} for ${user.address}`);
	}
}

async function _getETHFromOtherUsers({ ctx, user, amount }) {
	for (const otherUser of Object.values(ctx.users)) {
		if (otherUser.address === user.address) {
			continue;
		}

		const otherUserBalance = await ctx.provider.getBalance(otherUser.address);
		if (otherUserBalance.gte(ethers.utils.parseEther('1000'))) {
			const tx = await otherUser.sendTransaction({
				to: user.address,
				value: amount,
			});

			await tx.wait();

			return;
		}
	}

	throw new Error('Unable to get ETH');
}

async function _getWETH({ ctx, user, amount }) {
	const ethBalance = await ctx.provider.getBalance(user.address);
	if (ethBalance.lt(amount)) {
		const needed = amount.sub(ethBalance);

		await _getETHFromOtherUsers({ ctx, user, amount: needed });
	}

	let { WETH } = ctx.contracts;
	WETH = WETH.connect(user);

	const tx = await WETH.deposit({
		value: amount,
	});

	await tx.wait();
}

async function _getSNX({ ctx, user, amount }) {
	const { ProxySynthetix } = ctx.contracts;
	let { Synthetix } = ctx.contracts;

	// connect via proxy
	Synthetix = new ethers.Contract(ProxySynthetix.address, Synthetix.interface, ctx.provider);

	const ownerTransferable = await Synthetix.transferableSynthetix(ctx.users.owner.address);
	if (ownerTransferable.lt(amount)) {
		await _getSNXForOwner({ ctx, amount: amount.sub(ownerTransferable) });
	}

	Synthetix = Synthetix.connect(ctx.users.owner);
	const tx = await Synthetix.transfer(user.address, amount);
	await tx.wait();
}

async function _getSNXForOwner({ ctx, amount }) {
	if (!ctx.useOvm) {
		throw new Error('There is no more SNX!');
	} else {
		if (ctx.l1) {
			await _getSNXForOwnerOnL2ByDepositing({ ctx: ctx.l1, amount });
		} else {
			await _getSNXForOwnerOnL2ByHackMinting({ ctx, amount });
		}
	}
}

async function _getSNXForOwnerOnL2ByDepositing({ ctx, amount }) {
	await deposit({ ctx, from: ctx.users.owner, to: ctx.users.owner, amount });
}

async function _getSNXForOwnerOnL2ByHackMinting({ ctx, amount }) {
	const owner = ctx.users.owner;

	let { Synthetix, AddressResolver } = ctx.contracts;

	const bridgeName = toBytes32('SynthetixBridgeToBase');
	const bridgeAddress = await AddressResolver.getAddress(bridgeName);

	let tx;

	AddressResolver = AddressResolver.connect(owner);
	tx = await AddressResolver.importAddresses([bridgeName], [owner.address]);
	await tx.wait();
	tx = await AddressResolver.rebuildCaches([Synthetix.address]);
	await tx.wait();

	Synthetix = Synthetix.connect(owner);
	tx = await Synthetix.mintSecondary(owner.address, amount);
	await tx.wait();

	tx = await AddressResolver.importAddresses([bridgeName], [bridgeAddress]);
	await tx.wait();
	tx = await AddressResolver.rebuildCaches([Synthetix.address]);
	await tx.wait();
}

async function _getsUSD({ ctx, user, amount }) {
	const { ProxySynthetix, ProxysUSD } = ctx.contracts;
	let { Synthetix, SynthsUSD } = ctx.contracts;

	// connect via proxy
	Synthetix = new ethers.Contract(ProxySynthetix.address, Synthetix.interface, ctx.provider);
	SynthsUSD = new ethers.Contract(ProxysUSD.address, SynthsUSD.interface, ctx.provider);

	let tx;

	const requiredSNX = await _getSNXAmountRequiredForsUSDAmount({ ctx, amount });
	await ensureBalance({ ctx, symbol: 'SNX', user, balance: requiredSNX });

	Synthetix = Synthetix.connect(ctx.users.owner);

	const tmpWallet = await ethers.Wallet.createRandom().connect(ctx.provider);

	await _getETHFromOtherUsers({
		ctx,
		symbol: 'ETH',
		user: tmpWallet,
		amount: ethers.utils.parseEther('1'),
	});

	tx = await Synthetix.transfer(tmpWallet.address, requiredSNX.mul(2));
	await tx.wait();

	tx = await Synthetix.connect(tmpWallet).issueSynths(amount);
	await tx.wait();

	tx = await SynthsUSD.connect(tmpWallet).transfer(user.address, amount);
	await tx.wait();
}

async function _getSynth({ ctx, user, symbol, amount }) {
	let spent = ethers.utils.parseEther('0');
	let partialAmount = ethers.utils.parseEther('1000'); // choose a "reasonable" amount to start with

	let remaining = amount;

	const token = _getTokenFromSymbol({ ctx, symbol });

	// requiring from within function to prevent circular dependency
	const { exchangeSynths } = require('./exchanging');

	while (remaining.gt(0)) {
		await exchangeSynths({
			ctx,
			dest: symbol,
			src: 'sUSD',
			amount: partialAmount,
			user,
		});

		spent = spent.add(partialAmount);
		const newBalance = await token.balanceOf(user.address);

		if (newBalance.eq(0)) {
			throw new Error('received no synths from exchange, did breaker trip? is rate set?');
		}

		remaining = amount.sub(newBalance);

		// estimate what more to send based on the rate we got for the first exchange
		partialAmount = spent.mul(remaining.add(remaining.div(10))).div(newBalance);
	}
}

async function _getSNXAmountRequiredForsUSDAmount({ ctx, amount }) {
	const { Exchanger, SystemSettings } = ctx.contracts;

	const ratio = await SystemSettings.issuanceRatio();
	const collateral = ethers.utils.parseEther(amount.div(ratio).toString());

	const [expectedAmount, ,] = await Exchanger.getAmountsForExchange(
		collateral,
		toBytes32('sUSD'),
		toBytes32('SNX')
	);

	return expectedAmount;
}

function _getTokenFromSymbol({ ctx, symbol }) {
	if (symbol === 'SNX') {
		return ctx.contracts.Synthetix;
	} else if (symbol === 'WETH') {
		return ctx.contracts.WETH;
	} else {
		return ctx.contracts[`Synth${symbol}`];
	}
}

module.exports = {
	ensureBalance,
};
