// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract AIBotBattle {
    address public owner;
    IERC20 public usdt;
    uint256 public constant FEE_BPS = 10; // 0.1%

    struct Round {
        uint256 id;
        uint256 ai1Pool;
        uint256 ai2Pool;
        bool settled;
        uint8 winner; // 1 or 2
        mapping(address => uint256) ai1Bets;
        mapping(address => uint256) ai2Bets;
        address[] ai1Bettors;
        address[] ai2Bettors;
    }

    mapping(uint256 => Round) public rounds;
    uint256 public currentRoundId;

    event BetPlaced(uint256 roundId, address user, uint8 side, uint256 amount);
    event RoundSettled(uint256 roundId, uint8 winner, uint256 totalPool);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address _usdt) {
        owner = msg.sender;
        usdt  = IERC20(_usdt);
    }

    function startRound() external onlyOwner returns (uint256) {
        currentRoundId++;
        Round storage r = rounds[currentRoundId];
        r.id = currentRoundId;
        return currentRoundId;
    }

    function bet(uint256 roundId, uint8 side, uint256 amount) external {
        require(side == 1 || side == 2, "invalid side");
        require(amount >= 1e6, "min 1 USDT"); // USDT has 6 decimals
        Round storage r = rounds[roundId];
        require(!r.settled, "round ended");

        usdt.transferFrom(msg.sender, address(this), amount);

        if (side == 1) {
            if (r.ai1Bets[msg.sender] == 0) r.ai1Bettors.push(msg.sender);
            r.ai1Bets[msg.sender] += amount;
            r.ai1Pool += amount;
        } else {
            if (r.ai2Bets[msg.sender] == 0) r.ai2Bettors.push(msg.sender);
            r.ai2Bets[msg.sender] += amount;
            r.ai2Pool += amount;
        }

        emit BetPlaced(roundId, msg.sender, side, amount);
    }

    function settle(uint256 roundId, uint8 winner) external onlyOwner {
        Round storage r = rounds[roundId];
        require(!r.settled, "already settled");
        require(winner == 1 || winner == 2, "invalid winner");

        r.settled = true;
        r.winner  = winner;

        uint256 totalPool   = r.ai1Pool + r.ai2Pool;
        uint256 fee         = (totalPool * FEE_BPS) / 10000;
        uint256 payoutPool  = totalPool - fee;

        // Send fee to owner
        if (fee > 0) usdt.transfer(owner, fee);

        // Pay winners proportionally
        uint256 winPool  = winner == 1 ? r.ai1Pool : r.ai2Pool;
        address[] storage winners = winner == 1 ? r.ai1Bettors : r.ai2Bettors;

        for (uint i = 0; i < winners.length; i++) {
            address user    = winners[i];
            uint256 userBet = winner == 1 ? r.ai1Bets[user] : r.ai2Bets[user];
            uint256 payout  = (userBet * payoutPool) / winPool;
            usdt.transfer(user, payout);
        }

        emit RoundSettled(roundId, winner, totalPool);
    }

    function getPoolSizes(uint256 roundId) external view returns (uint256 ai1Pool, uint256 ai2Pool) {
        return (rounds[roundId].ai1Pool, rounds[roundId].ai2Pool);
    }

    function getUserBet(uint256 roundId, address user) external view returns (uint256 ai1, uint256 ai2) {
        return (rounds[roundId].ai1Bets[user], rounds[roundId].ai2Bets[user]);
    }
}