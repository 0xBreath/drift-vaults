import * as anchor from '@coral-xyz/anchor';
import { AnchorProvider, Program, Provider } from '@coral-xyz/anchor';
import {
	AccountLayout,
	MintLayout,
	NATIVE_MINT,
	TOKEN_PROGRAM_ID,
	getMinimumBalanceForRentExemptMint,
	getMinimumBalanceForRentExemptAccount,
	createInitializeMintInstruction,
	createInitializeAccountInstruction,
	createMintToInstruction,
	createWrappedNativeAccount,
} from '@solana/spl-token';
import {
	Connection,
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
	sendAndConfirmTransaction,
	SystemProgram,
	Transaction,
	TransactionSignature,
} from '@solana/web3.js';
import { assert } from 'chai';
import buffer from 'buffer';
import {
	BN,
	Wallet,
	OraclePriceData,
	OracleInfo,
	BulkAccountLoader,
	TestClient,
	SPOT_MARKET_RATE_PRECISION,
	SPOT_MARKET_WEIGHT_PRECISION,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	User,
	OracleSource,
	MarketStatus,
	DriftClient,
	DriftClientConfig,
} from '@drift-labs/sdk';
import { IDL, VaultClient } from '../ts/sdk';

export const MOCK_USDC_MINT = anchor.web3.Keypair.generate();
export const MOCK_ORACLE = anchor.web3.Keypair.generate();

export async function mockOracle(
	price: number = 50 * 10e7,
	expo = -7,
	confidence?: number,
	tokenFeed?: Keypair
): Promise<PublicKey> {
	// default: create a $50 coin oracle
	const program = anchor.workspace.Pyth;

	anchor.setProvider(
		anchor.AnchorProvider.local(undefined, {
			commitment: 'confirmed',
			preflightCommitment: 'confirmed',
		})
	);

	const priceFeedAddress = await createPriceFeed({
		oracleProgram: program,
		initPrice: price,
		expo: expo,
		confidence,
		tokenFeed,
	});

	const feedData = await getFeedData(program, priceFeedAddress);
	if (feedData.price !== price) {
		console.log('mockOracle precision error:', feedData.price, '!=', price);
	}
	assert.ok(Math.abs(feedData.price - price) < 1e-10);

	return priceFeedAddress;
}

export async function mockUSDCMint(
	provider: Provider,
	mint?: Keypair
): Promise<Keypair> {
	let fakeUSDCMint: Keypair;
	if (mint) {
		fakeUSDCMint = mint;
	} else {
		fakeUSDCMint = anchor.web3.Keypair.generate();
	}
	const createUSDCMintAccountIx = SystemProgram.createAccount({
		// @ts-ignore
		fromPubkey: provider.wallet.publicKey,
		newAccountPubkey: fakeUSDCMint.publicKey,
		lamports: await getMinimumBalanceForRentExemptMint(provider.connection),
		space: MintLayout.span,
		programId: TOKEN_PROGRAM_ID,
	});
	const initCollateralMintIx = createInitializeMintInstruction(
		fakeUSDCMint.publicKey,
		6,
		// @ts-ignore
		provider.wallet.publicKey,
		// @ts-ignore
		provider.wallet.publicKey
	);

	const fakeUSDCTx = new Transaction();
	fakeUSDCTx.add(createUSDCMintAccountIx);
	fakeUSDCTx.add(initCollateralMintIx);

	await sendAndConfirmTransaction(
		provider.connection,
		fakeUSDCTx,
		// @ts-ignore
		[provider.wallet.payer, fakeUSDCMint],
		{
			skipPreflight: false,
			commitment: 'recent',
			preflightCommitment: 'recent',
		}
	);
	return fakeUSDCMint;
}

export async function mockUserUSDCAccount(
	fakeUSDCMint: Keypair,
	usdcMintAmount: BN,
	provider: Provider,
	owner?: PublicKey
): Promise<Keypair> {
	const userUSDCAccount = anchor.web3.Keypair.generate();
	const fakeUSDCTx = new Transaction();

	if (owner === undefined) {
		// @ts-ignore
		owner = provider.wallet.publicKey;
	}

	const createUSDCTokenAccountIx = SystemProgram.createAccount({
		// @ts-ignore
		fromPubkey: provider.wallet.publicKey,
		newAccountPubkey: userUSDCAccount.publicKey,
		lamports: await getMinimumBalanceForRentExemptAccount(provider.connection),
		space: AccountLayout.span,
		programId: TOKEN_PROGRAM_ID,
	});
	fakeUSDCTx.add(createUSDCTokenAccountIx);

	const initUSDCTokenAccountIx = createInitializeAccountInstruction(
		userUSDCAccount.publicKey,
		fakeUSDCMint.publicKey,
		owner
	);
	fakeUSDCTx.add(initUSDCTokenAccountIx);

	const mintToUserAccountTx = createMintToInstruction(
		fakeUSDCMint.publicKey,
		userUSDCAccount.publicKey,
		// @ts-ignore
		provider.wallet.publicKey,
		usdcMintAmount.toNumber()
	);
	fakeUSDCTx.add(mintToUserAccountTx);

	try {
		const _fakeUSDCTxResult = await sendAndConfirmTransaction(
			provider.connection,
			fakeUSDCTx,
			// @ts-ignore
			[provider.wallet.payer, userUSDCAccount],
			{
				skipPreflight: false,
				commitment: 'recent',
				preflightCommitment: 'recent',
			}
		);
		return userUSDCAccount;
	} catch (e) {
		console.log('FAILED:', e);
	}
}

export async function mintUSDCToUser(
	fakeUSDCMint: Keypair,
	userUSDCAccount: PublicKey,
	usdcMintAmount: BN,
	provider: Provider
): Promise<void> {
	const tx = new Transaction();
	const mintToUserAccountTx = await createMintToInstruction(
		fakeUSDCMint.publicKey,
		userUSDCAccount,
		// @ts-ignore
		provider.wallet.publicKey,
		usdcMintAmount.toNumber()
	);
	tx.add(mintToUserAccountTx);

	await sendAndConfirmTransaction(
		provider.connection,
		tx,
		// @ts-ignore
		[provider.wallet.payer],
		{
			skipPreflight: false,
			commitment: 'recent',
			preflightCommitment: 'recent',
		}
	);
}

export async function createFundedKeyPair(
	connection: Connection
): Promise<Keypair> {
	const userKeyPair = new Keypair();
	await connection.requestAirdrop(userKeyPair.publicKey, 10 ** 9);
	return userKeyPair;
}

export async function createUSDCAccountForUser(
	provider: AnchorProvider,
	userKeyPair: Keypair,
	usdcMint: Keypair,
	usdcAmount: BN
): Promise<PublicKey> {
	const userUSDCAccount = await mockUserUSDCAccount(
		usdcMint,
		usdcAmount,
		provider,
		userKeyPair.publicKey
	);
	return userUSDCAccount.publicKey;
}

export async function initializeAndSubscribeDriftClient(
	connection: Connection,
	program: Program,
	userKeyPair: Keypair,
	marketIndexes: number[],
	bankIndexes: number[],
	oracleInfos: OracleInfo[] = [],
	accountLoader?: BulkAccountLoader
): Promise<TestClient> {
	const driftClient = new TestClient({
		connection,
		wallet: new Wallet(userKeyPair),
		programID: program.programId,
		opts: {
			commitment: 'confirmed',
		},
		activeSubAccountId: 0,
		perpMarketIndexes: marketIndexes,
		spotMarketIndexes: bankIndexes,
		oracleInfos,
		accountSubscription: accountLoader
			? {
					type: 'polling',
					accountLoader,
			  }
			: {
					type: 'websocket',
			  },
	});
	await driftClient.subscribe();
	await driftClient.initializeUserAccount();
	return driftClient;
}

export async function createUserWithUSDCAccount(
	provider: AnchorProvider,
	usdcMint: Keypair,
	chProgram: Program,
	usdcAmount: BN,
	marketIndexes: number[],
	bankIndexes: number[],
	oracleInfos: OracleInfo[] = [],
	accountLoader?: BulkAccountLoader
): Promise<[TestClient, PublicKey, Keypair]> {
	const userKeyPair = await createFundedKeyPair(provider.connection);
	const usdcAccount = await createUSDCAccountForUser(
		provider,
		userKeyPair,
		usdcMint,
		usdcAmount
	);
	const driftClient = await initializeAndSubscribeDriftClient(
		provider.connection,
		chProgram,
		userKeyPair,
		marketIndexes,
		bankIndexes,
		oracleInfos,
		accountLoader
	);

	return [driftClient, usdcAccount, userKeyPair];
}

export async function createWSolTokenAccountForUser(
	provider: AnchorProvider,
	userKeypair: Keypair | Wallet,
	amount: BN
): Promise<PublicKey> {
	await provider.connection.requestAirdrop(
		userKeypair.publicKey,
		amount.toNumber() +
			(await getMinimumBalanceForRentExemptAccount(provider.connection))
	);
	return await createWrappedNativeAccount(
		provider.connection,
		// @ts-ignore
		provider.wallet.payer,
		userKeypair.publicKey,
		amount.toNumber()
	);
}

export async function createUserWithUSDCAndWSOLAccount(
	provider: AnchorProvider,
	usdcMint: Keypair,
	chProgram: Program,
	solAmount: BN,
	usdcAmount: BN,
	marketIndexes: number[],
	bankIndexes: number[],
	oracleInfos: OracleInfo[] = [],
	accountLoader?: BulkAccountLoader
): Promise<[TestClient, PublicKey, PublicKey, Keypair]> {
	const userKeyPair = await createFundedKeyPair(provider.connection);
	const solAccount = await createWSolTokenAccountForUser(
		provider,
		userKeyPair,
		solAmount
	);
	const usdcAccount = await createUSDCAccountForUser(
		provider,
		userKeyPair,
		usdcMint,
		usdcAmount
	);
	const driftClient = await initializeAndSubscribeDriftClient(
		provider.connection,
		chProgram,
		userKeyPair,
		marketIndexes,
		bankIndexes,
		oracleInfos,
		accountLoader
	);

	return [driftClient, solAccount, usdcAccount, userKeyPair];
}

export async function printTxLogs(
	connection: Connection,
	txSig: TransactionSignature
): Promise<void> {
	console.log(
		'tx logs',
		(await connection.getTransaction(txSig, { commitment: 'confirmed' })).meta
			.logMessages
	);
}

export async function mintToInsuranceFund(
	chInsuranceAccountPubkey: PublicKey,
	fakeUSDCMint: Keypair,
	amount: BN,
	provider: Provider
): Promise<TransactionSignature> {
	const mintToUserAccountTx = await createMintToInstruction(
		fakeUSDCMint.publicKey,
		chInsuranceAccountPubkey,
		// @ts-ignore
		provider.wallet.publicKey,
		amount.toNumber()
	);

	const fakeUSDCTx = new Transaction();
	fakeUSDCTx.add(mintToUserAccountTx);

	return await sendAndConfirmTransaction(
		provider.connection,
		fakeUSDCTx,
		// @ts-ignore
		[provider.wallet.payer],
		{
			skipPreflight: false,
			commitment: 'recent',
			preflightCommitment: 'recent',
		}
	);
}

export async function initUserAccounts(
	NUM_USERS: number,
	usdcMint: Keypair,
	usdcAmount: BN,
	provider: Provider,
	marketIndexes: number[],
	bankIndexes: number[],
	oracleInfos: OracleInfo[],
	accountLoader?: BulkAccountLoader
) {
	const user_keys = [];
	const userUSDCAccounts = [];
	const driftClients = [];
	const userAccountInfos = [];

	let userAccountPublicKey: PublicKey;

	for (let i = 0; i < NUM_USERS; i++) {
		console.log('user', i, 'initialize');

		const owner = anchor.web3.Keypair.generate();
		const ownerWallet = new anchor.Wallet(owner);
		await provider.connection.requestAirdrop(ownerWallet.publicKey, 100000000);

		const newUserAcct = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			ownerWallet.publicKey
		);

		const chProgram = anchor.workspace.Drift as anchor.Program; // this.program-ify

		const driftClient1 = new TestClient({
			connection: provider.connection,
			//@ts-ignore
			wallet: ownerWallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: marketIndexes,
			spotMarketIndexes: bankIndexes,
			oracleInfos,
			accountSubscription: accountLoader
				? {
						type: 'polling',
						accountLoader,
				  }
				: {
						type: 'websocket',
				  },
		});

		// await driftClient1.initialize(usdcMint.publicKey, false);
		await driftClient1.subscribe();

		userUSDCAccounts.push(newUserAcct);
		driftClients.push(driftClient1);
		// var last_idx = userUSDCAccounts.length - 1;

		// try {
		[, userAccountPublicKey] =
			await driftClient1.initializeUserAccountAndDepositCollateral(
				// marketPublicKey,
				usdcAmount,
				newUserAcct.publicKey
			);

		// const userAccount = 0;
		const userAccount = new User({
			driftClient: driftClient1,
			userAccountPublicKey: await driftClient1.getUserAccountPublicKey(),
		});
		await userAccount.subscribe();

		userAccountInfos.push(userAccount);

		// } catch (e) {
		// 	assert(true);
		// }

		user_keys.push(userAccountPublicKey);
	}
	return [userUSDCAccounts, user_keys, driftClients, userAccountInfos];
}

const empty32Buffer = buffer.Buffer.alloc(32);
const PKorNull = (data) =>
	data.equals(empty32Buffer) ? null : new anchor.web3.PublicKey(data);

export const createPriceFeed = async ({
	oracleProgram,
	initPrice,
	confidence = undefined,
	expo = -4,
	tokenFeed,
}: {
	oracleProgram: Program;
	initPrice: number;
	confidence?: number;
	expo?: number;
	tokenFeed?: Keypair;
}): Promise<PublicKey> => {
	const conf = new BN(confidence) || new BN((initPrice / 10) * 10 ** -expo);
	let collateralTokenFeed: Keypair;
	if (tokenFeed) {
		collateralTokenFeed = tokenFeed;
	} else {
		collateralTokenFeed = Keypair.generate();
	}
	await oracleProgram.methods
		.initialize(new BN(initPrice * 10 ** -expo), expo, conf)
		.accounts({ price: collateralTokenFeed.publicKey })
		.signers([collateralTokenFeed])
		.preInstructions([
			anchor.web3.SystemProgram.createAccount({
				// @ts-ignore
				fromPubkey: oracleProgram.provider.wallet.publicKey,
				newAccountPubkey: collateralTokenFeed.publicKey,
				space: 3312,
				lamports:
					await oracleProgram.provider.connection.getMinimumBalanceForRentExemption(
						3312
					),
				programId: oracleProgram.programId,
			}),
		])
		.rpc();
	return collateralTokenFeed.publicKey;
};

export const setFeedPrice = async (
	oracleProgram: Program,
	newPrice: number,
	priceFeed: PublicKey
) => {
	const info = await oracleProgram.provider.connection.getAccountInfo(
		priceFeed
	);
	const data = parsePriceData(info.data);
	await oracleProgram.rpc.setPrice(new BN(newPrice * 10 ** -data.exponent), {
		accounts: { price: priceFeed },
	});
};
export const setFeedTwap = async (
	oracleProgram: Program,
	newTwap: number,
	priceFeed: PublicKey
) => {
	const info = await oracleProgram.provider.connection.getAccountInfo(
		priceFeed
	);
	const data = parsePriceData(info.data);
	await oracleProgram.rpc.setTwap(new BN(newTwap * 10 ** -data.exponent), {
		accounts: { price: priceFeed },
	});
};
export const getFeedData = async (
	oracleProgram: Program,
	priceFeed: PublicKey
) => {
	const info = await oracleProgram.provider.connection.getAccountInfo(
		priceFeed
	);
	return parsePriceData(info.data);
};

export const getOraclePriceData = async (
	oracleProgram: Program,
	priceFeed: PublicKey
): Promise<OraclePriceData> => {
	const info = await oracleProgram.provider.connection.getAccountInfo(
		priceFeed
	);
	const interData = parsePriceData(info.data);
	const oraclePriceData: OraclePriceData = {
		price: new BN(interData.price * PRICE_PRECISION.toNumber()),
		slot: new BN(interData.currentSlot.toString()),
		confidence: new BN(interData.confidence * PRICE_PRECISION.toNumber()),
		hasSufficientNumberOfDataPoints: true,
	};

	return oraclePriceData;
};

// https://github.com/nodejs/node/blob/v14.17.0/lib/internal/errors.js#L758
const ERR_BUFFER_OUT_OF_BOUNDS = () =>
	new Error('Attempt to access memory outside buffer bounds');
// https://github.com/nodejs/node/blob/v14.17.0/lib/internal/errors.js#L968
const ERR_INVALID_ARG_TYPE = (name, expected, actual) =>
	new Error(
		`The "${name}" argument must be of type ${expected}. Received ${actual}`
	);
// https://github.com/nodejs/node/blob/v14.17.0/lib/internal/errors.js#L1262
const ERR_OUT_OF_RANGE = (str, range, received) =>
	new Error(
		`The value of "${str} is out of range. It must be ${range}. Received ${received}`
	);
// https://github.com/nodejs/node/blob/v14.17.0/lib/internal/validators.js#L127-L130
function validateNumber(value, name) {
	if (typeof value !== 'number')
		throw ERR_INVALID_ARG_TYPE(name, 'number', value);
}
// https://github.com/nodejs/node/blob/v14.17.0/lib/internal/buffer.js#L68-L80
function boundsError(value, length) {
	if (Math.floor(value) !== value) {
		validateNumber(value, 'offset');
		throw ERR_OUT_OF_RANGE('offset', 'an integer', value);
	}
	if (length < 0) throw ERR_BUFFER_OUT_OF_BOUNDS();
	throw ERR_OUT_OF_RANGE('offset', `>= 0 and <= ${length}`, value);
}
function readBigInt64LE(buffer, offset = 0) {
	validateNumber(offset, 'offset');
	const first = buffer[offset];
	const last = buffer[offset + 7];
	if (first === undefined || last === undefined)
		boundsError(offset, buffer.length - 8);
	const val =
		buffer[offset + 4] +
		buffer[offset + 5] * 2 ** 8 +
		buffer[offset + 6] * 2 ** 16 +
		(last << 24); // Overflow
	return (
		(BigInt(val) << BigInt(32)) +
		BigInt(
			first +
				buffer[++offset] * 2 ** 8 +
				buffer[++offset] * 2 ** 16 +
				buffer[++offset] * 2 ** 24
		)
	);
}
// https://github.com/nodejs/node/blob/v14.17.0/lib/internal/buffer.js#L89-L107
function readBigUInt64LE(buffer, offset = 0) {
	validateNumber(offset, 'offset');
	const first = buffer[offset];
	const last = buffer[offset + 7];
	if (first === undefined || last === undefined)
		boundsError(offset, buffer.length - 8);
	const lo =
		first +
		buffer[++offset] * 2 ** 8 +
		buffer[++offset] * 2 ** 16 +
		buffer[++offset] * 2 ** 24;
	const hi =
		buffer[++offset] +
		buffer[++offset] * 2 ** 8 +
		buffer[++offset] * 2 ** 16 +
		last * 2 ** 24;
	return BigInt(lo) + (BigInt(hi) << BigInt(32)); // tslint:disable-line:no-bitwise
}

const parsePriceData = (data) => {
	// Pyth magic number.
	const magic = data.readUInt32LE(0);
	// Program version.
	const version = data.readUInt32LE(4);
	// Account type.
	const type = data.readUInt32LE(8);
	// Price account size.
	const size = data.readUInt32LE(12);
	// Price or calculation type.
	const priceType = data.readUInt32LE(16);
	// Price exponent.
	const exponent = data.readInt32LE(20);
	// Number of component prices.
	const numComponentPrices = data.readUInt32LE(24);
	// unused
	// const unused = accountInfo.data.readUInt32LE(28)
	// Currently accumulating price slot.
	const currentSlot = readBigUInt64LE(data, 32);
	// Valid on-chain slot of aggregate price.
	const validSlot = readBigUInt64LE(data, 40);
	// Time-weighted average price.
	const twapComponent = readBigInt64LE(data, 48);
	const twap = Number(twapComponent) * 10 ** exponent;
	// Annualized price volatility.
	const avolComponent = readBigUInt64LE(data, 56);
	const avol = Number(avolComponent) * 10 ** exponent;
	// Space for future derived values.
	const drv0Component = readBigInt64LE(data, 64);
	const drv0 = Number(drv0Component) * 10 ** exponent;
	const drv1Component = readBigInt64LE(data, 72);
	const drv1 = Number(drv1Component) * 10 ** exponent;
	const drv2Component = readBigInt64LE(data, 80);
	const drv2 = Number(drv2Component) * 10 ** exponent;
	const drv3Component = readBigInt64LE(data, 88);
	const drv3 = Number(drv3Component) * 10 ** exponent;
	const drv4Component = readBigInt64LE(data, 96);
	const drv4 = Number(drv4Component) * 10 ** exponent;
	const drv5Component = readBigInt64LE(data, 104);
	const drv5 = Number(drv5Component) * 10 ** exponent;
	// Product id / reference account.
	const productAccountKey = new anchor.web3.PublicKey(data.slice(112, 144));
	// Next price account in list.
	const nextPriceAccountKey = PKorNull(data.slice(144, 176));
	// Aggregate price updater.
	const aggregatePriceUpdaterAccountKey = new anchor.web3.PublicKey(
		data.slice(176, 208)
	);
	const aggregatePriceInfo = parsePriceInfo(data.slice(208, 240), exponent);
	// Price components - up to 32.
	const priceComponents = [];
	let offset = 240;
	let shouldContinue = true;
	while (offset < data.length && shouldContinue) {
		const publisher = PKorNull(data.slice(offset, offset + 32));
		offset += 32;
		if (publisher) {
			const aggregate = parsePriceInfo(
				data.slice(offset, offset + 32),
				exponent
			);
			offset += 32;
			const latest = parsePriceInfo(data.slice(offset, offset + 32), exponent);
			offset += 32;
			priceComponents.push({ publisher, aggregate, latest });
		} else {
			shouldContinue = false;
		}
	}
	return Object.assign(
		Object.assign(
			{
				magic,
				version,
				type,
				size,
				priceType,
				exponent,
				numComponentPrices,
				currentSlot,
				validSlot,
				twapComponent,
				twap,
				avolComponent,
				avol,
				drv0Component,
				drv0,
				drv1Component,
				drv1,
				drv2Component,
				drv2,
				drv3Component,
				drv3,
				drv4Component,
				drv4,
				drv5Component,
				drv5,
				productAccountKey,
				nextPriceAccountKey,
				aggregatePriceUpdaterAccountKey,
			},
			aggregatePriceInfo
		),
		{ priceComponents }
	);
};
const _parseProductData = (data) => {
	// Pyth magic number.
	const magic = data.readUInt32LE(0);
	// Program version.
	const version = data.readUInt32LE(4);
	// Account type.
	const type = data.readUInt32LE(8);
	// Price account size.
	const size = data.readUInt32LE(12);
	// First price account in list.
	const priceAccountBytes = data.slice(16, 48);
	const priceAccountKey = new anchor.web3.PublicKey(priceAccountBytes);
	const product = {};
	let idx = 48;
	while (idx < data.length) {
		const keyLength = data[idx];
		idx++;
		if (keyLength) {
			const key = data.slice(idx, idx + keyLength).toString();
			idx += keyLength;
			const valueLength = data[idx];
			idx++;
			const value = data.slice(idx, idx + valueLength).toString();
			idx += valueLength;
			product[key] = value;
		}
	}
	return { magic, version, type, size, priceAccountKey, product };
};

const parsePriceInfo = (data, exponent) => {
	// Aggregate price.
	const priceComponent = data.readBigUInt64LE(0);
	const price = Number(priceComponent) * 10 ** exponent;
	// Aggregate confidence.
	const confidenceComponent = data.readBigUInt64LE(8);
	const confidence = Number(confidenceComponent) * 10 ** exponent;
	// Aggregate status.
	const status = data.readUInt32LE(16);
	// Aggregate corporate action.
	const corporateAction = data.readUInt32LE(20);
	// Aggregate publish slot.
	const publishSlot = data.readBigUInt64LE(24);
	return {
		priceComponent,
		price,
		confidenceComponent,
		confidence,
		status,
		corporateAction,
		publishSlot,
	};
};

export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getTokenAmountAsBN(
	connection: Connection,
	tokenAccount: PublicKey
): Promise<BN> {
	return new BN(
		(await connection.getTokenAccountBalance(tokenAccount)).value.amount
	);
}

export async function initializeQuoteSpotMarket(
	admin: TestClient,
	usdcMint: PublicKey
): Promise<void> {
	const optimalUtilization = SPOT_MARKET_RATE_PRECISION.div(
		new BN(2)
	).toNumber(); // 50% utilization
	const optimalRate = SPOT_MARKET_RATE_PRECISION.toNumber();
	const maxRate = SPOT_MARKET_RATE_PRECISION.toNumber();
	const initialAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
	const maintenanceAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
	const initialLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
	const maintenanceLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.toNumber();
	const imfFactor = 0;
	const marketIndex = admin.getStateAccount().numberOfSpotMarkets;

	await admin.initializeSpotMarket(
		usdcMint,
		optimalUtilization,
		optimalRate,
		maxRate,
		PublicKey.default,
		OracleSource.QUOTE_ASSET,
		initialAssetWeight,
		maintenanceAssetWeight,
		initialLiabilityWeight,
		maintenanceLiabilityWeight,
		imfFactor
	);
	await admin.updateWithdrawGuardThreshold(
		marketIndex,
		new BN(10 ** 10).mul(QUOTE_PRECISION)
	);
	await admin.updateSpotMarketStatus(marketIndex, MarketStatus.ACTIVE);
}

export async function initializeSolSpotMarket(
	admin: TestClient,
	solOracle: PublicKey,
	solMint = NATIVE_MINT
): Promise<string> {
	const optimalUtilization = SPOT_MARKET_RATE_PRECISION.div(
		new BN(2)
	).toNumber(); // 50% utilization
	const optimalRate = SPOT_MARKET_RATE_PRECISION.mul(new BN(20)).toNumber(); // 2000% APR
	const maxRate = SPOT_MARKET_RATE_PRECISION.mul(new BN(50)).toNumber(); // 5000% APR
	const initialAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.mul(new BN(8))
		.div(new BN(10))
		.toNumber();
	const maintenanceAssetWeight = SPOT_MARKET_WEIGHT_PRECISION.mul(new BN(9))
		.div(new BN(10))
		.toNumber();
	const initialLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.mul(new BN(12))
		.div(new BN(10))
		.toNumber();
	const maintenanceLiabilityWeight = SPOT_MARKET_WEIGHT_PRECISION.mul(
		new BN(11)
	)
		.div(new BN(10))
		.toNumber();
	const marketIndex = admin.getStateAccount().numberOfSpotMarkets;

	const txSig = await admin.initializeSpotMarket(
		solMint,
		optimalUtilization,
		optimalRate,
		maxRate,
		solOracle,
		OracleSource.PYTH,
		initialAssetWeight,
		maintenanceAssetWeight,
		initialLiabilityWeight,
		maintenanceLiabilityWeight
	);
	await admin.updateWithdrawGuardThreshold(
		marketIndex,
		new BN(10 ** 10).mul(QUOTE_PRECISION)
	);
	await admin.updateSpotMarketStatus(marketIndex, MarketStatus.ACTIVE);
	return txSig;
}

export async function bootstrapSignerClientAndUser(params: {
	payer: AnchorProvider;
	programId: PublicKey;
	usdcMint: Keypair;
	usdcAmount: BN;
	depositCollateral?: boolean;
	vaultClientCliMode?: boolean;
	driftClientConfig?: Omit<DriftClientConfig, 'connection' | 'wallet'>;
}): Promise<{
	signer: Keypair;
	user: User;
	userUSDCAccount: Keypair;
	driftClient: DriftClient;
	vaultClient: VaultClient;
	provider: AnchorProvider;
}> {
	const {
		payer,
		programId,
		usdcMint,
		usdcAmount,
		depositCollateral,
		vaultClientCliMode,
		driftClientConfig,
	} = params;
	const {
		accountSubscription,
		opts,
		activeSubAccountId,
		perpMarketIndexes,
		spotMarketIndexes,
		oracleInfos,
	} = driftClientConfig;

	const signer = Keypair.generate();
	await payer.connection.requestAirdrop(signer.publicKey, LAMPORTS_PER_SOL);
	await sleep(1000);

	const driftClient = new DriftClient({
		connection: payer.connection,
		wallet: new Wallet(signer),
		opts: {
			commitment: 'confirmed',
		},
		activeSubAccountId,
		perpMarketIndexes,
		spotMarketIndexes,
		oracleInfos,
		accountSubscription,
	});
	const provider = new anchor.AnchorProvider(
		payer.connection,
		new anchor.Wallet(signer),
		opts
	);
	const program = new Program(IDL, programId, provider);
	const vaultClient = new VaultClient({
		driftClient,
		program,
		cliMode: vaultClientCliMode ?? true,
	});
	const userUSDCAccount = await mockUserUSDCAccount(
		usdcMint,
		usdcAmount,
		payer,
		signer.publicKey
	);
	await driftClient.subscribe();
	if (depositCollateral) {
		await driftClient.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey,
			0,
			activeSubAccountId
		);
	} else {
		await driftClient.initializeUserAccount(activeSubAccountId ?? 0);
	}
	const user = new User({
		driftClient,
		userAccountPublicKey: await driftClient.getUserAccountPublicKey(),
	});
	await user.subscribe();
	return {
		signer,
		user,
		userUSDCAccount,
		driftClient,
		vaultClient,
		provider,
	};
}
