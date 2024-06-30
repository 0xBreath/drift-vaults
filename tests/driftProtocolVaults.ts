import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import {
	AdminClient,
	BN,
	BulkAccountLoader,
	ZERO,
	PRICE_PRECISION,
	User,
	OracleSource,
	PublicKey,
	getLimitOrderParams,
	PostOnlyParams,
	PositionDirection,
	getUserAccountPublicKey,
	UserAccount,
	QUOTE_PRECISION,
	getOrderParams, MarketType,
	PEG_PRECISION,
	BASE_PRECISION,
} from '@drift-labs/sdk';
import {
	bootstrapSignerClientAndUser,
	initializeQuoteSpotMarket,
	mockOracle,
	mockUSDCMint,
	setFeedPrice,
} from './testHelpers';
import { Keypair } from '@solana/web3.js';
import { assert } from 'chai';
import {
	VaultClient,
	getVaultAddressSync,
	getVaultDepositorAddressSync,
	encodeName,
	DriftVaults,
	VaultProtocolParams,
	getVaultProtocolAddressSync,
} from '../ts/sdk';

describe('driftProtocolVaults', () => {
	// Configure the client to use the local cluster.
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		skipPreflight: false,
		commitment: 'confirmed',
	});
	anchor.setProvider(provider);
	const connection = provider.connection;
	const program = anchor.workspace.DriftVaults as Program<DriftVaults>;

	const bulkAccountLoader = new BulkAccountLoader(connection, 'confirmed', 1);

	const adminClient = new AdminClient({
		connection,
		wallet: provider.wallet,
		accountSubscription: {
			type: 'websocket',
			resubTimeoutMs: 30_000,
		},
	});

	let manager: Keypair;
	let managerClient: VaultClient;
	let managerUser: User;

	let makerClient: VaultClient;
	let makerUser: User;

	let vd: Keypair;
	let vdClient: VaultClient;
	let vdUser: User;
	let vdUserUSDCAccount: Keypair;

	let delegate: Keypair;
	let delegateClient: VaultClient;

	// ammInvariant == k == x * y
	// const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const mantissaSqrtScale = new BN(100_000);
	const ammInitialQuoteAssetReserve = new BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	let usdcMint: Keypair;
	let solPerpOracle: PublicKey;

	const protocol = Keypair.generate().publicKey;
	const vaultName = 'protocol vault';
	const vault = getVaultAddressSync(program.programId, encodeName(vaultName));

	const VAULT_PROTOCOL_DISCRIM: number[] = [106, 130, 5, 195, 126, 82, 249, 53];

	const initialSolPerpPrice = 100;
	const finalSolPerpPrice = initialSolPerpPrice + 1;
	const usdcAmount = new BN(1000).mul(QUOTE_PRECISION);
	const baseAssetAmount = new BN(1).mul(BASE_PRECISION);

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		solPerpOracle = await mockOracle(initialSolPerpPrice);
		const perpMarketIndexes = [0];
		const spotMarketIndexes = [0];
		const oracleInfos = [
			{ publicKey: solPerpOracle, source: OracleSource.PYTH },
		];

		const setupClient = new AdminClient({
			connection,
			wallet: provider.wallet,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes,
			spotMarketIndexes,
			oracleInfos,
			accountSubscription: {
				type: 'polling',
				accountLoader: bulkAccountLoader,
			},
		});

		await setupClient.initialize(usdcMint.publicKey, true);
		await setupClient.subscribe();
		await initializeQuoteSpotMarket(setupClient, usdcMint.publicKey);

		const periodicity = new BN(60 * 60); // 1 HOUR
		await setupClient.initializePerpMarket(
			0,
			solPerpOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(initialSolPerpPrice).mul(PEG_PRECISION)
		);
		await setupClient.updatePerpAuctionDuration(new BN(0));
		await setupClient.unsubscribe();

		// init vault manager
		const bootstrapManager = await bootstrapSignerClientAndUser({
			payer: provider,
			programId: program.programId,
			usdcMint,
			usdcAmount,
			driftClientConfig: {
				accountSubscription: {
					type: 'websocket',
					resubTimeoutMs: 30_000,
				},
				opts: {
					preflightCommitment: 'confirmed',
					skipPreflight: false,
					commitment: 'confirmed',
				},
				activeSubAccountId: 0,
				perpMarketIndexes,
				spotMarketIndexes,
				oracleInfos,
			},
		});
		manager = bootstrapManager.signer;
		managerClient = bootstrapManager.vaultClient;
		managerUser = bootstrapManager.user;

		// init delegate who trades with vault funds
		const bootstrapDelegate = await bootstrapSignerClientAndUser({
			payer: provider,
			programId: program.programId,
			usdcMint,
			usdcAmount,
			driftClientConfig: {
				accountSubscription: {
					type: 'websocket',
					resubTimeoutMs: 30_000,
				},
				opts: {
					preflightCommitment: 'confirmed',
					skipPreflight: false,
					commitment: 'confirmed',
				},
				activeSubAccountId: 0,
				perpMarketIndexes,
				spotMarketIndexes,
				oracleInfos,
			},
		});
		delegate = bootstrapDelegate.signer;
		delegateClient = bootstrapDelegate.vaultClient;

		// init a market maker for manager to trade against
		const bootstrapMaker = await bootstrapSignerClientAndUser({
			payer: provider,
			programId: program.programId,
			usdcMint,
			usdcAmount,
			depositCollateral: true,
			driftClientConfig: {
				accountSubscription: {
					type: 'websocket',
					resubTimeoutMs: 30_000,
				},
				opts: {
					preflightCommitment: 'confirmed',
					skipPreflight: false,
					commitment: 'confirmed',
				},
				activeSubAccountId: 0,
				perpMarketIndexes,
				spotMarketIndexes,
				oracleInfos,
			},
		});
		makerClient = bootstrapMaker.vaultClient;
		makerUser = bootstrapMaker.user;

		// init VaultDepositor for manager to trade on behalf of.
		// the VaultDepositor is the admin/provider.wallet.
		const bootstrapVD = await bootstrapSignerClientAndUser({
			payer: provider,
			programId: program.programId,
			usdcMint,
			usdcAmount,
			depositCollateral: false,
			driftClientConfig: {
				accountSubscription: {
					type: 'websocket',
					resubTimeoutMs: 30_000,
				},
				opts: {
					preflightCommitment: 'confirmed',
					skipPreflight: false,
					commitment: 'confirmed',
				},
				activeSubAccountId: 0,
				perpMarketIndexes,
				spotMarketIndexes,
				oracleInfos,
			},
		});
		vd = bootstrapVD.signer;
		vdClient = bootstrapVD.vaultClient;
		vdUser = bootstrapVD.user;
		vdUserUSDCAccount = bootstrapVD.userUSDCAccount;

		// start admin client
		await adminClient.subscribe();

		// start account loader
		bulkAccountLoader.startPolling();
		await bulkAccountLoader.load();
	});

	after(async () => {
		await managerClient.driftClient.unsubscribe();
		await makerClient.driftClient.unsubscribe();
		await vdClient.driftClient.unsubscribe();
		await adminClient.unsubscribe();

		await managerUser.unsubscribe();
		await makerUser.unsubscribe();
		await vdUser.subscribe();

		bulkAccountLoader.stopPolling();
	});

	it('Initialize Protocol Vault', async () => {
		const vpParams: VaultProtocolParams = {
			protocol,
			protocolFee: new BN(0),
			protocolProfitShare: 0,
		};
		await managerClient.initializeVault({
			name: encodeName(vaultName),
			spotMarketIndex: 0,
			redeemPeriod: ZERO,
			maxTokens: ZERO,
			managementFee: ZERO,
			profitShare: 0,
			hurdleRate: 0,
			permissioned: false,
			minDepositAmount: ZERO,
			vaultProtocol: vpParams,
		});
		const vaultAcct = await managerClient.program.account.vault.fetch(vault);
		assert(vaultAcct.manager.equals(manager.publicKey));
		const vp = getVaultProtocolAddressSync(
			managerClient.program.programId,
			vault
		);
		// asserts "exit" was called on VaultProtocol to define the discriminator
		const vpAcctInfo = await connection.getAccountInfo(vp);
		assert(vpAcctInfo.data.includes(Buffer.from(VAULT_PROTOCOL_DISCRIM)));

		// asserts Vault and VaultProtocol fields were set properly
		const vpAcct = await managerClient.program.account.vaultProtocol.fetch(vp);
		assert(vaultAcct.vaultProtocol.equals(vp));
		assert(vpAcct.protocol.equals(protocol));
	});

	it('Update Delegate', async () => {
		const vaultAccount = await program.account.vault.fetch(vault);
		await managerClient.program.methods
			.updateDelegate(delegate.publicKey)
			.accounts({
				vault,
				driftUser: vaultAccount.user,
				driftProgram: adminClient.program.programId,
			})
			.rpc();
		const user = (await adminClient.program.account.user.fetch(
			vaultAccount.user
		)) as UserAccount;
		assert(user.delegate.equals(delegate.publicKey));
	});

	it('Initialize Vault Depositor', async () => {
		await vdClient.initializeVaultDepositor(vault, vd.publicKey);
		const vaultDepositor = getVaultDepositorAddressSync(
			vdClient.program.programId,
			vault,
			vd.publicKey
		);
		const vdAcct = await vdClient.program.account.vaultDepositor.fetch(
			vaultDepositor
		);
		assert(vdAcct.vault.equals(vault));
	});

	// vault depositor deposits USDC to the vault's token account
	it('Vault Depositor Deposit', async () => {
		const vaultAccount = await vdClient.program.account.vault.fetch(vault);
		const vaultDepositor = getVaultDepositorAddressSync(
			vdClient.program.programId,
			vault,
			vd.publicKey
		);
		const remainingAccounts = adminClient.getRemainingAccounts({
			userAccounts: [],
			writableSpotMarketIndexes: [0],
		});
		const vaultProtocol = getVaultProtocolAddressSync(
			managerClient.program.programId,
			vault
		);
		remainingAccounts.push({
			pubkey: vaultProtocol,
			isSigner: false,
			isWritable: true,
		});

		await vdClient.program.methods
			.deposit(usdcAmount)
			.accounts({
				vault,
				vaultDepositor,
				vaultTokenAccount: vaultAccount.tokenAccount,
				driftUserStats: vaultAccount.userStats,
				driftUser: vaultAccount.user,
				driftState: await adminClient.getStatePublicKey(),
				userTokenAccount: vdUserUSDCAccount.publicKey,
				driftSpotMarketVault: adminClient.getSpotMarketAccount(0).vault,
				driftProgram: adminClient.program.programId,
			})
			.remainingAccounts(remainingAccounts)
			.rpc();
	});

	it('Vault Long SOL-PERP', async () => {
		// vault user account is delegated to "delegate"
		const vaultUserAcct = (
			await delegateClient.driftClient.getUserAccountsForDelegate(
				delegate.publicKey
			)
		)[0];
		assert(vaultUserAcct.authority.equals(vault));
		assert(vaultUserAcct.delegate.equals(delegate.publicKey));

		assert(vaultUserAcct.totalDeposits.eq(usdcAmount));
		const balance =
			vaultUserAcct.totalDeposits.toNumber() / QUOTE_PRECISION.toNumber();
		console.log('vault usdc balance:', balance);

		const marketIndex = 0;

		// manager places long order and waits to be filled by the maker
		const takerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.LONG,
			baseAssetAmount,
			price: new BN(finalSolPerpPrice * PRICE_PRECISION.toNumber()),
			auctionStartPrice: new BN(initialSolPerpPrice * PRICE_PRECISION.toNumber()),
			auctionEndPrice: new BN(finalSolPerpPrice * PRICE_PRECISION.toNumber()),
			auctionDuration: 10,
			userOrderId: 1,
			postOnly: PostOnlyParams.NONE,
		});
		// delegate assumes control of vault user
		await delegateClient.driftClient.addUser(0, vault, vaultUserAcct);
		await delegateClient.driftClient.switchActiveUser(0, vault);
		console.log('delegate assumed control of vault user');

		const delegateActiveUser = delegateClient.driftClient.getUser(0, vault);
		const vaultUserKey = await getUserAccountPublicKey(
			delegateClient.driftClient.program.programId,
			vault,
			0
		);
		assert(delegateActiveUser.userAccountPublicKey.equals(vaultUserKey), "delegate active user is not vault user");

		try {
			// await delegateClient.driftClient.placePerpOrder(takerOrderParams);

			const orderParams = getOrderParams(takerOrderParams, { marketType: MarketType.PERP });

			const remainingAccounts = delegateClient.driftClient.getRemainingAccounts({
				userAccounts: [delegateActiveUser.getUserAccount()],
				useMarketLastSlotCache: true,
				readablePerpMarketIndex: orderParams.marketIndex,
			});

			const placePerpOrderIx =  await delegateClient.driftClient.program.methods
				.placePerpOrder(orderParams)
				.accounts({
					state: await delegateClient.driftClient.getStatePublicKey(),
					user: delegateActiveUser.userAccountPublicKey,
					userStats: delegateClient.driftClient.getUserStatsAccountPublicKey(),
					authority: delegateClient.driftClient.wallet.publicKey,
				})
				.remainingAccounts(remainingAccounts)
				.instruction();

			const {  slot } = await delegateClient.driftClient.sendTransaction(
				await delegateClient.driftClient.buildTransaction(
					placePerpOrderIx,
					delegateClient.driftClient.txParams
				),
				[],
				delegateClient.driftClient.opts
			);
			delegateClient.driftClient.perpMarketLastSlotCache.set(orderParams.marketIndex, slot);
		} catch (e) {
			console.log('failed to long:', e);
		}

		await delegateActiveUser.fetchAccounts();
		const order = delegateActiveUser.getOrderByUserOrderId(1);
		assert(!order.postOnly, "order should not be postOnly");

		// market maker fills vault delegate's long
		const makerOrderParams = getLimitOrderParams({
			marketIndex,
			direction: PositionDirection.SHORT,
			baseAssetAmount,
			price: new BN(initialSolPerpPrice).mul(PRICE_PRECISION),
			userOrderId: 1,
			postOnly: PostOnlyParams.MUST_POST_ONLY,
			immediateOrCancel: true,
		});
		try {
			await makerClient.driftClient.placeAndMakePerpOrder(makerOrderParams, {
				taker: await delegateClient.driftClient.getUserAccountPublicKey(0, vault),
				order,
				takerUserAccount: delegateClient.driftClient.getUserAccount(0, vault),
				takerStats: delegateClient.driftClient.getUserStatsAccountPublicKey(),
			});
		} catch (e) {
			console.log('maker failed to fill vault:', e);
		}

		// check positions from vault and maker are accurate
		const makerPosition = makerClient.driftClient.getUser().getPerpPosition(0);
		assert(makerPosition.baseAssetAmount.eq(baseAssetAmount.neg()), "maker position is not baseAssetAmount");
		await delegateActiveUser.fetchAccounts();
		const vaultPosition = delegateClient.driftClient.getUser(0, vault).getPerpPosition(0);
		assert(vaultPosition.baseAssetAmount.eq(baseAssetAmount), "vault position is not baseAssetAmount");
	});

	// increase price of SOL perp by 5%
	it('Increase SOL-PERP Price', async () => {
		const preOD = adminClient.getOracleDataForPerpMarket(0);
		const priceBefore = preOD.price.toNumber() / PRICE_PRECISION.toNumber();
		console.log('price before:', priceBefore);
		assert(priceBefore === initialSolPerpPrice);

		try {
			// increase AMM
			await adminClient.moveAmmToPrice(
				0,
				new BN(finalSolPerpPrice * PRICE_PRECISION.toNumber())
			);
		} catch (e) {
			console.log('failed to move amm price:', e);
			assert(false);
		}

		const solPerpMarket = adminClient.getPerpMarketAccount(0);

		try {
			// increase oracle
			await setFeedPrice(
				anchor.workspace.Pyth,
				finalSolPerpPrice,
				solPerpMarket.amm.oracle
			);
		} catch (e) {
			console.log('failed to set feed price:', e);
			assert(false);
		}

		const postOD = adminClient.getOracleDataForPerpMarket(0);
		const priceAfter = postOD.price.toNumber() / PRICE_PRECISION.toNumber();
		console.log('price after:', priceAfter);
		assert(priceAfter === finalSolPerpPrice);
	});

	// manager exits long for a profit
	it('Short SOL-PERP', async () => {
		const marketIndex = 0;

		await delegateClient.driftClient.switchActiveUser(0, vault);
		const delegateUser = delegateClient.driftClient.getUser(0, vault);

		try {
			// manager places long order and waits to be filled by the maker
			const takerOrderParams = getLimitOrderParams({
				marketIndex,
				direction: PositionDirection.SHORT,
				baseAssetAmount,
				price: new BN(initialSolPerpPrice * PRICE_PRECISION.toNumber()),
				auctionStartPrice: new BN(finalSolPerpPrice * PRICE_PRECISION.toNumber()),
				auctionEndPrice: new BN(initialSolPerpPrice * PRICE_PRECISION.toNumber()),
				auctionDuration: 10,
				userOrderId: 2,
				postOnly: PostOnlyParams.NONE,
			});

			const orderParams = getOrderParams(takerOrderParams, { marketType: MarketType.PERP });

			const remainingAccounts = delegateClient.driftClient.getRemainingAccounts({
				userAccounts: [delegateUser.getUserAccount()],
				useMarketLastSlotCache: true,
				readablePerpMarketIndex: orderParams.marketIndex,
			});

			const placePerpOrderIx =  await delegateClient.driftClient.program.methods
				.placePerpOrder(orderParams)
				.accounts({
					state: await delegateClient.driftClient.getStatePublicKey(),
					user: delegateUser.userAccountPublicKey,
					userStats: delegateClient.driftClient.getUserStatsAccountPublicKey(),
					authority: delegateClient.driftClient.wallet.publicKey,
				})
				.remainingAccounts(remainingAccounts)
				.instruction();

			const { slot } = await delegateClient.driftClient.sendTransaction(
				await delegateClient.driftClient.buildTransaction(
					placePerpOrderIx,
					delegateClient.driftClient.txParams
				),
				[],
				delegateClient.driftClient.opts
			);
			delegateClient.driftClient.perpMarketLastSlotCache.set(orderParams.marketIndex, slot);
		} catch (e) {
			console.log('failed to short:', e);
		}

		await delegateUser.fetchAccounts();
		const order = delegateUser.getOrderByUserOrderId(2);
		assert(!order.postOnly);

		await delegateClient.driftClient.fetchAccounts();
		await makerClient.driftClient.fetchAccounts();

		try {
			// market maker fills manager's short
			const makerOrderParams = getLimitOrderParams({
				marketIndex,
				direction: PositionDirection.LONG,
				baseAssetAmount,
				price: new BN(finalSolPerpPrice).mul(PRICE_PRECISION),
				userOrderId: 2,
				postOnly: PostOnlyParams.MUST_POST_ONLY,
				immediateOrCancel: true,
			});
			await makerClient.driftClient.placeAndMakePerpOrder(makerOrderParams, {
				taker: await delegateClient.driftClient.getUserAccountPublicKey(0, vault),
				order,
				takerUserAccount: delegateClient.driftClient.getUserAccount(0, vault),
				takerStats: delegateClient.driftClient.getUserStatsAccountPublicKey(),
			});
		} catch (e) {
			console.log('failed to make with long order:', e);
			assert(false);
		}

		const makerUser = makerClient.driftClient.getUser();
		// await makerUser.fetchAccounts();
		const vaultUser = delegateClient.driftClient.getUser(0, vault);
		// await vaultUser.fetchAccounts();

		const makerPosition = makerUser.getPerpPosition(0);
		console.log('maker position:', makerPosition.baseAssetAmount.toNumber() / BASE_PRECISION.toNumber());
		const vaultPosition = vaultUser.getPerpPosition(0);
		console.log('vault position:', vaultPosition.baseAssetAmount.toNumber() / BASE_PRECISION.toNumber());

		assert(makerPosition.baseAssetAmount.eq(ZERO));
		assert(vaultPosition.baseAssetAmount.eq(ZERO));
	});

	// it('Settle Pnl', async () => {
	// 	const vaultUser = delegateClient.driftClient.getUser(0, vault);
	// 	const uA = vaultUser.getUserAccount();
	// 	assert(uA.idle == false);
	// 	const activePerps = vaultUser.getActivePerpPositions();
	// 	assert(activePerps.length == 1);
	// 	const solPerpPos = vaultUser.getPerpPosition(0);
	// 	console.log(
	// 		'sol perp quote:',
	// 		solPerpPos.quoteAssetAmount.toNumber() / QUOTE_PRECISION.toNumber()
	// 	);
	// 	// assert(14.841723 == solPerpPos.quoteAssetAmount.toNumber() / QUOTE_PRECISION.toNumber());
	// 	console.log(
	// 		'sol perp base:',
	// 		solPerpPos.baseAssetAmount.toNumber() / BASE_PRECISION.toNumber()
	// 	);
	// 	assert(solPerpPos.baseAssetAmount.eq(ZERO));
	// 	console.log(
	// 		'free collateral:',
	// 		vaultUser.getFreeCollateral().toNumber() / QUOTE_PRECISION.toNumber()
	// 	);
	// 	// $30 initial usdc deposit to account not including ~$15 unsettled pnl from trade
	// 	assert(usdcAmount.eq(vaultUser.getFreeCollateral()));
	//
	// 	const quotePrice =
	// 		vaultUser.driftClient.getOracleDataForSpotMarket(0).price;
	// 	console.log(
	// 		'USDC price:',
	// 		quotePrice.toNumber() / PRICE_PRECISION.toNumber()
	// 	);
	// 	const solPrice = vaultUser.driftClient.getOracleDataForPerpMarket(0);
	// 	console.log(
	// 		'SOL price:',
	// 		solPrice.price.toNumber() / PRICE_PRECISION.toNumber()
	// 	);
	// 	assert(
	// 		finalSolPerpPrice ==
	// 			solPrice.price.toNumber() / PRICE_PRECISION.toNumber()
	// 	);
	//
	// 	const solPerpMarket = delegateClient.driftClient.getPerpMarketAccount(0);
	// 	const pnl =
	// 		calculatePositionPNL(
	// 			solPerpMarket,
	// 			solPerpPos,
	// 			false,
	// 			solPrice
	// 		).toNumber() / QUOTE_PRECISION.toNumber();
	// 	console.log('pos pnl:', pnl.toString());
	//
	// 	const upnl =
	// 		vaultUser.getUnrealizedPNL().toNumber() / QUOTE_PRECISION.toNumber();
	// 	console.log('upnl:', upnl.toString());
	// 	assert(pnl == upnl);
	//
	// 	await vaultUser.fetchAccounts();
	// 	try {
	// 		const txSig = await delegateClient.driftClient.settlePNL(
	// 			vaultUser.userAccountPublicKey,
	// 			vaultUser.getUserAccount(),
	// 			0
	// 		);
	// 		await printTxLogs(connection, txSig);
	// 	} catch (e) {
	// 		console.log(e);
	// 		assert(false);
	// 	}
	// });
	//
	// it('Withdraw', async () => {
	//   const vaultAccount = await program.account.vault.fetch(vault);
	//   const vaultDepositor = getVaultDepositorAddressSync(
	//     program.programId,
	//     vault,
	//     vd.publicKey
	//   );
	//   const remainingAccounts = vdClient.driftClient.getRemainingAccounts({
	//     userAccounts: [],
	// 		writableSpotMarketIndexes: [0],
	// 		readablePerpMarketIndex: 0,
	//   });
	// 	const vaultProtocol = getVaultProtocolAddressSync(
	// 		managerClient.program.programId,
	// 		vault
	// 	);
	// 	remainingAccounts.push({
	// 		pubkey: vaultProtocol,
	// 		isSigner: false,
	// 		isWritable: true,
	// 	});
	//
	//   const vaultDepositorAccount = await program.account.vaultDepositor.fetch(vaultDepositor);
	//   assert(vaultDepositorAccount.lastWithdrawRequest.value.eq(new BN(0)));
	// 	// $100 initial deposit = 100_000_000 shares
	//   assert(vaultDepositorAccount.vaultShares.eq(new BN(100_000_000)));
	//
	// 	await vdClient.requestWithdraw(
	// 		vaultDepositor,
	// 		usdcAmount,
	// 		WithdrawUnit.TOKEN
	// 	);
	//
	//   const vaultDepositorAccountAfter =
	//     await program.account.vaultDepositor.fetch(vaultDepositor);
	//   assert(vaultDepositorAccountAfter.vaultShares.eq(new BN(100_000_000)));
	// 	console.log('withdraw shares:', vaultDepositorAccountAfter.lastWithdrawRequest.shares.toNumber());
	// 	console.log('withdraw value:', vaultDepositorAccountAfter.lastWithdrawRequest.value.toNumber());
	// 	assert(
	//     !vaultDepositorAccountAfter.lastWithdrawRequest.shares.eq(new BN(0))
	//   );
	//   assert(!vaultDepositorAccountAfter.lastWithdrawRequest.value.eq(new BN(0)));
	//
	// 	const vdAcct =
	// 		await program.account.vaultDepositor.fetch(vaultDepositor);
	// 	assert(vdAcct.vault.equals(vault));
	//
	//   // do withdraw
	//   try {
	// 		// this is done manually because vaultClient.withdraw(vaultDepositor) would use the USDC
	// 		// associated token account as opposed to the keypair we generated to serve as a USDC token account.
	//     const txSig = await vdClient.program.methods
	//       .withdraw()
	//       .accounts({
	//         userTokenAccount: vdUserUSDCAccount.publicKey,
	//         vault,
	//         vaultDepositor,
	//         vaultTokenAccount: vaultAccount.tokenAccount,
	//         driftUser: vaultAccount.user,
	//         driftUserStats: vaultAccount.userStats,
	//         driftState: await vdClient.driftClient.getStatePublicKey(),
	//         driftSpotMarketVault: vdClient.driftClient.getSpotMarketAccount(0).vault,
	//         driftSigner: vdClient.driftClient.getStateAccount().signer,
	//         driftProgram: vdClient.driftClient.program.programId,
	//       })
	//       .remainingAccounts(remainingAccounts)
	//       .rpc();
	//
	//     await printTxLogs(provider.connection, txSig);
	//   } catch (e) {
	//     console.error(e);
	// 		assert(false);
	//   }
	// });
});