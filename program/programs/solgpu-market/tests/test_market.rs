//! SolGPU マーケットのテスト（LiteSVM 上で実際のプログラムを動かす）
use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    solgpu_market::{
        accounts as acc, instruction as ix, state::{Listing, Rental, RentalStatus}, ACCEPT_TIMEOUT_SECS,
    },
};

const PRICE: u64 = 25_000;
const SOL: u64 = 1_000_000_000;

struct Keys {
    owner: Keypair,
    operator: Keypair,
    renter: Keypair,
    stranger: Keypair,
    listing: Pubkey,
}

struct Env {
    svm: LiteSVM,
    k: Keys,
}

fn send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, signers: &[&Keypair]) -> Result<(), String> {
    svm.expire_blockhash();
    let bh = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &bh);
    let mut all: Vec<&Keypair> = vec![payer];
    for s in signers {
        if s.pubkey() != payer.pubkey() {
            all.push(s);
        }
    }
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &all).unwrap();
    svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.meta.logs))
}

fn listing_pda(owner: &Pubkey, id: u64) -> Pubkey {
    Pubkey::find_program_address(&[b"listing", owner.as_ref(), &id.to_le_bytes()], &solgpu_market::id()).0
}
fn rental_pda(listing: &Pubkey, renter: &Pubkey, nonce: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[b"rental", listing.as_ref(), renter.as_ref(), &nonce.to_le_bytes()],
        &solgpu_market::id(),
    )
    .0
}

fn get<T: AccountDeserialize>(svm: &LiteSVM, key: &Pubkey) -> T {
    let a = svm.get_account(key).expect("account missing");
    T::try_deserialize(&mut a.data.as_slice()).unwrap()
}
fn balance(svm: &LiteSVM, key: &Pubkey) -> u64 {
    svm.get_account(key).map(|a| a.lamports).unwrap_or(0)
}
fn warp(svm: &mut LiteSVM, secs: i64) {
    let mut c: Clock = svm.get_sysvar();
    c.unix_timestamp += secs;
    svm.set_sysvar(&c);
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/solgpu_market.so"));
    svm.add_program(solgpu_market::id(), bytes).unwrap();
    let mut c: Clock = svm.get_sysvar();
    c.unix_timestamp = 1_800_000_000;
    svm.set_sysvar(&c);
    let (owner, operator, renter, stranger) = (Keypair::new(), Keypair::new(), Keypair::new(), Keypair::new());
    for k in [&owner, &operator, &renter, &stranger] {
        svm.airdrop(&k.pubkey(), 10 * SOL).unwrap();
    }
    let listing = listing_pda(&owner.pubkey(), 1);
    let create = Instruction::new_with_bytes(
        solgpu_market::id(),
        &ix::CreateListing {
            listing_id: 1,
            operator: operator.pubkey(),
            agent_url: "https://example.trycloudflare.com".into(),
            gpu: "Intel Arc 140T".into(),
            tflops_x100: 1297,
            lamports_per_minute: PRICE,
        }
        .data(),
        acc::CreateListing { owner: owner.pubkey(), listing, system_program: system_program::ID }.to_account_metas(None),
    );
    send(&mut svm, &[create], &owner, &[]).unwrap();
    Env { svm, k: Keys { owner, operator, renter, stranger, listing } }
}

fn rent_ix(e: &Keys, renter: &Pubkey, nonce: u64, minutes: u32, price: u64) -> (Instruction, Pubkey) {
    let rental = rental_pda(&e.listing, renter, nonce);
    (
        Instruction::new_with_bytes(
            solgpu_market::id(),
            &ix::RentGpu { nonce, minutes, expected_lamports_per_minute: price, secret_hash: [7u8; 32] }.data(),
            acc::RentGpu { renter: *renter, listing: e.listing, rental, system_program: system_program::ID }
                .to_account_metas(None),
        ),
        rental,
    )
}
fn accept_ix(e: &Keys, operator: &Pubkey, rental: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        solgpu_market::id(),
        &ix::Accept {}.data(),
        acc::Accept { operator: *operator, listing: e.listing, rental }.to_account_metas(None),
    )
}
fn settle_ix(e: &Keys, caller: &Pubkey, rental: Pubkey, owner: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        solgpu_market::id(),
        &ix::Settle {}.data(),
        acc::Settle { caller: *caller, listing: e.listing, rental, owner, renter: e.renter.pubkey() }
            .to_account_metas(None),
    )
}
fn refund_ix(e: &Keys, caller: &Pubkey, rental: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        solgpu_market::id(),
        &ix::Refund {}.data(),
        acc::Refund { caller: *caller, listing: e.listing, rental, renter: e.renter.pubkey() }.to_account_metas(None),
    )
}
fn close_ix(e: &Keys) -> Instruction {
    Instruction::new_with_bytes(
        solgpu_market::id(),
        &ix::CloseListing {}.data(),
        acc::CloseListing { owner: e.owner.pubkey(), listing: e.listing }.to_account_metas(None),
    )
}

#[test]
fn happy_path_rent_accept_settle() {
    let mut e = setup();
    let renter = e.k.renter.pubkey();
    let owner_before = balance(&e.svm, &e.k.owner.pubkey());

    let (rent, rental) = rent_ix(&e.k, &renter, 42, 10, PRICE);
    send(&mut e.svm, &[rent], &e.k.renter, &[]).unwrap();
    let r: Rental = get(&e.svm, &rental);
    assert_eq!(r.amount, 10 * PRICE);
    assert_eq!(r.status, RentalStatus::Pending);
    let l: Listing = get(&e.svm, &e.k.listing);
    assert_eq!(l.open_rentals, 1);
    assert_eq!(l.busy_until, r.accept_deadline);

    // 予約中は他の人が借りられない
    let stranger = e.k.stranger.pubkey();
    let (rent2, _) = rent_ix(&e.k, &stranger, 1, 5, PRICE);
    assert!(send(&mut e.svm, &[rent2], &e.k.stranger, &[]).unwrap_err().contains("ListingBusy"));

    // エージェント以外は開始できない
    let stranger_kp = e.k.stranger.insecure_clone();
    assert!(send(&mut e.svm, &[accept_ix(&e.k, &stranger, rental)], &stranger_kp, &[])
        .unwrap_err()
        .contains("NotOperator"));

    // エージェントが開始
    let op = e.k.operator.pubkey();
    let op_kp = e.k.operator.insecure_clone();
    send(&mut e.svm, &[accept_ix(&e.k, &op, rental)], &op_kp, &[]).unwrap();
    let r: Rental = get(&e.svm, &rental);
    assert_eq!(r.status, RentalStatus::Active);
    assert_eq!(r.ends_at - r.started_at, 600);

    // 開始後は返金できない
    let renter_kp = e.k.renter.insecure_clone();
    assert!(send(&mut e.svm, &[refund_ix(&e.k, &renter, rental)], &renter_kp, &[])
        .unwrap_err()
        .contains("NotPending"));

    // 終了前は精算できない
    let owner = e.k.owner.pubkey();
    assert!(send(&mut e.svm, &[settle_ix(&e.k, &stranger, rental, owner)], &stranger_kp, &[])
        .unwrap_err()
        .contains("NotEnded"));

    // 受取先をすり替えた精算は失敗
    warp(&mut e.svm, 601);
    assert!(send(&mut e.svm, &[settle_ix(&e.k, &stranger, rental, stranger)], &stranger_kp, &[]).is_err());

    // 終了後は誰でも精算でき、代金は必ず貸し手へ
    let renter_before = balance(&e.svm, &renter);
    let rental_lamports = balance(&e.svm, &rental);
    send(&mut e.svm, &[settle_ix(&e.k, &stranger, rental, owner)], &stranger_kp, &[]).unwrap();
    assert_eq!(balance(&e.svm, &owner), owner_before + 10 * PRICE);
    assert_eq!(balance(&e.svm, &renter), renter_before + rental_lamports - 10 * PRICE); // 保証金は借り手へ
    assert!(e.svm.get_account(&rental).map(|a| a.lamports == 0).unwrap_or(true));
    let l: Listing = get(&e.svm, &e.k.listing);
    assert_eq!(l.open_rentals, 0);

    // 未精算が無くなったので取り下げ可能
    let owner_kp = e.k.owner.insecure_clone();
    send(&mut e.svm, &[close_ix(&e.k)], &owner_kp, &[]).unwrap();
}

#[test]
fn refund_paths() {
    let mut e = setup();
    let renter = e.k.renter.pubkey();
    let stranger = e.k.stranger.pubkey();
    let renter_kp = e.k.renter.insecure_clone();
    let stranger_kp = e.k.stranger.insecure_clone();
    let owner_kp = e.k.owner.insecure_clone();
    let start = balance(&e.svm, &renter);

    // 価格が変わっていたら借りられない
    let (bad, _) = rent_ix(&e.k, &renter, 1, 10, PRICE + 1);
    assert!(send(&mut e.svm, &[bad], &e.k.renter, &[]).unwrap_err().contains("PriceChanged"));
    // 時間の上限
    let (bad, _) = rent_ix(&e.k, &renter, 1, 241, PRICE);
    assert!(send(&mut e.svm, &[bad], &e.k.renter, &[]).unwrap_err().contains("InvalidMinutes"));

    // 借り手本人は開始前ならいつでもキャンセルでき、全額戻る（手数料を除く）
    let (rent, rental) = rent_ix(&e.k, &renter, 1, 10, PRICE);
    send(&mut e.svm, &[rent], &e.k.renter, &[]).unwrap();
    assert!(send(&mut e.svm, &[close_ix(&e.k)], &owner_kp, &[]).unwrap_err().contains("HasOpenRentals"));
    send(&mut e.svm, &[refund_ix(&e.k, &renter, rental)], &renter_kp, &[]).unwrap();
    // 減ったのは手数料（数回分）だけで、代金 10 * PRICE と保証金は戻っている
    assert!(start - balance(&e.svm, &renter) <= 4 * 5_000, "lost {}", start - balance(&e.svm, &renter));
    let l: Listing = get(&e.svm, &e.k.listing);
    assert_eq!(l.open_rentals, 0);

    // キャンセル後はすぐ借りられる
    let (rent, rental) = rent_ix(&e.k, &renter, 2, 10, PRICE);
    send(&mut e.svm, &[rent], &e.k.renter, &[]).unwrap();

    // 他人は期限前に返金できない
    assert!(send(&mut e.svm, &[refund_ix(&e.k, &stranger, rental)], &stranger_kp, &[])
        .unwrap_err()
        .contains("RefundNotAllowed"));

    // 期限を過ぎるとエージェントは開始できず、誰でも返金できる（代金は借り手へ）
    warp(&mut e.svm, ACCEPT_TIMEOUT_SECS + 1);
    let op = e.k.operator.pubkey();
    let op_kp = e.k.operator.insecure_clone();
    assert!(send(&mut e.svm, &[accept_ix(&e.k, &op, rental)], &op_kp, &[])
        .unwrap_err()
        .contains("AcceptDeadlinePassed"));
    let before = balance(&e.svm, &renter);
    let held = balance(&e.svm, &rental);
    send(&mut e.svm, &[refund_ix(&e.k, &stranger, rental)], &stranger_kp, &[]).unwrap();
    assert_eq!(balance(&e.svm, &renter), before + held);

    // 期限切れ後は他の人が借りられる
    let (rent, _) = rent_ix(&e.k, &stranger, 9, 1, PRICE);
    send(&mut e.svm, &[rent], &e.k.stranger, &[]).unwrap();
}

#[test]
fn listing_permissions() {
    let mut e = setup();
    let upd = |who: Pubkey, url: &str, active: bool| {
        Instruction::new_with_bytes(
            solgpu_market::id(),
            &ix::UpdateAgent { agent_url: url.into(), active }.data(),
            acc::UpdateAgent { authority: who, listing: e.k.listing }.to_account_metas(None),
        )
    };
    let stranger_kp = e.k.stranger.insecure_clone();
    let op_kp = e.k.operator.insecure_clone();
    let i = upd(e.k.stranger.pubkey(), "https://evil.example", true);
    assert!(send(&mut e.svm, &[i], &stranger_kp, &[]).unwrap_err().contains("NotOwnerOrOperator"));
    let i = upd(e.k.operator.pubkey(), "https://new.trycloudflare.com", false);
    send(&mut e.svm, &[i], &op_kp, &[]).unwrap();
    let l: Listing = get(&e.svm, &e.k.listing);
    assert_eq!(l.agent_url, "https://new.trycloudflare.com");
    assert!(!l.active);

    // 受付停止中は借りられない
    let renter = e.k.renter.pubkey();
    let (rent, _) = rent_ix(&e.k, &renter, 1, 1, PRICE);
    assert!(send(&mut e.svm, &[rent], &e.k.renter, &[]).unwrap_err().contains("ListingInactive"));

    // 不正な URL・価格
    let i = upd(e.k.operator.pubkey(), "ftp://x", true);
    assert!(send(&mut e.svm, &[i], &op_kp, &[]).unwrap_err().contains("InvalidUrl"));

    // 他人は価格を変えられない・取り下げられない
    let i = Instruction::new_with_bytes(
        solgpu_market::id(),
        &ix::UpdateListing { operator: e.k.stranger.pubkey(), gpu: "x".into(), tflops_x100: 1, lamports_per_minute: PRICE }
            .data(),
        acc::UpdateListing { owner: e.k.stranger.pubkey(), listing: e.k.listing }.to_account_metas(None),
    );
    assert!(send(&mut e.svm, &[i], &stranger_kp, &[]).is_err());
    let i = Instruction::new_with_bytes(
        solgpu_market::id(),
        &ix::CloseListing {}.data(),
        acc::CloseListing { owner: e.k.stranger.pubkey(), listing: e.k.listing }.to_account_metas(None),
    );
    assert!(send(&mut e.svm, &[i], &stranger_kp, &[]).is_err());
}
