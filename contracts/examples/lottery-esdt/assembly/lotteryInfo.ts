//@ts-nocheck

import { BigUint, ElrondArray, ElrondU32, ElrondU64, ElrondU8, TokenIdentifier } from "@gfusee/elrond-wasm-as";

@struct
export class LotteryInfo {
    tokenIdentifier!: TokenIdentifier
    ticketPrice!: BigUint
    ticketsLeft!: ElrondU32
    deadline!: ElrondU64
    maxEntriesPerUser!: ElrondU32
    prizeDistribution!: ElrondArray<ElrondU8>
    prizePool!: BigUint

    static new(
        tokenIdentifier: TokenIdentifier,
        ticketPrice: BigUint,
        ticketsLeft: ElrondU32,
        deadline: ElrondU64,
        maxEntriesPerUser: ElrondU32,
        prizeDistribution: ElrondArray<ElrondU8>,
        prizePool: BigUint,
    ): LotteryInfo {
        const result = new LotteryInfo()

        result.tokenIdentifier = tokenIdentifier
        result.ticketPrice = ticketPrice
        result.ticketsLeft = ticketsLeft
        result.deadline = deadline
        result.maxEntriesPerUser = maxEntriesPerUser
        result.prizeDistribution = prizeDistribution
        result.prizePool = prizePool

        return result
    }
}
