const express = require('express');
const router = express.Router();
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const simplifyDebts = require('../utils/simplifyDebts');

// Apply auth middleware
router.use(authMiddleware);

// GET / - Retrieve aggregated dashboard statistics and activity feed
router.get('/', async (req, res) => {
  try {
    const currentUserId = req.user.id;

    // 1. Get all groups user is part of
    const groupsRes = await pool.query(
      `SELECT g.id, g.name
       FROM groups g
       JOIN group_members gm ON g.id = gm.group_id
       WHERE gm.user_id = $1`,
      [currentUserId]
    );
    const groups = groupsRes.rows;

    // Map to aggregate net balances with other users across all groups
    // Key: otherUserId, Value: { user: { id, name, email }, netBalance }
    const userBalancesMap = {};

    for (let group of groups) {
      const groupId = group.id;

      // Fetch all members of this group
      const membersRes = await pool.query(
        'SELECT u.id, u.name, u.email FROM users u JOIN group_members gm ON u.id = gm.user_id WHERE gm.group_id = $1',
        [groupId]
      );
      const members = membersRes.rows;

      const balances = {};
      members.forEach(m => {
        balances[m.id.toString()] = 0;
      });

      // Fetch splits
      const splitsRes = await pool.query(
        `SELECT e.paid_by, s.user_id, s.amount
         FROM expenses e
         JOIN expense_splits s ON e.id = s.expense_id
         WHERE e.group_id = $1`,
        [groupId]
      );
      splitsRes.rows.forEach(row => {
        const paidByStr = row.paid_by.toString();
        const userIdStr = row.user_id.toString();
        const splitAmount = parseFloat(row.amount);

        if (balances[paidByStr] !== undefined) balances[paidByStr] += splitAmount;
        if (balances[userIdStr] !== undefined) balances[userIdStr] -= splitAmount;
      });

      // Fetch settlements
      const settlementsRes = await pool.query(
        `SELECT sender_id, receiver_id, amount
         FROM settlements
         WHERE group_id = $1`,
        [groupId]
      );
      settlementsRes.rows.forEach(row => {
        const senderStr = row.sender_id.toString();
        const receiverStr = row.receiver_id.toString();
        const amount = parseFloat(row.amount);

        if (balances[senderStr] !== undefined) balances[senderStr] += amount;
        if (balances[receiverStr] !== undefined) balances[receiverStr] -= amount;
      });

      // Format for simplifyDebts
      const netBalances = {};
      members.forEach(m => {
        netBalances[m.id.toString()] = Math.round(balances[m.id.toString()] * 100) / 100;
      });

      // Run simplify debts
      const simplifiedTx = simplifyDebts(netBalances, members);

      // Aggregate simplified transactions for current user
      simplifiedTx.forEach(tx => {
        if (tx.from.id === currentUserId) {
          // Current user owes tx.to
          const otherIdStr = tx.to.id.toString();
          if (!userBalancesMap[otherIdStr]) {
            userBalancesMap[otherIdStr] = {
              user: tx.to,
              netBalance: 0
            };
          }
          userBalancesMap[otherIdStr].netBalance -= tx.amount;
        } else if (tx.to.id === currentUserId) {
          // tx.from owes current user
          const otherIdStr = tx.from.id.toString();
          if (!userBalancesMap[otherIdStr]) {
            userBalancesMap[otherIdStr] = {
              user: tx.from,
              netBalance: 0
            };
          }
          userBalancesMap[otherIdStr].netBalance += tx.amount;
        }
      });
    }

    // Calculate overall stats
    let totalOwed = 0; // Money others owe current user (+)
    let totalOwe = 0;  // Money current user owes others (-)
    const userBalancesList = [];

    Object.keys(userBalancesMap).forEach(userIdStr => {
      const entry = userBalancesMap[userIdStr];
      const roundedBalance = Math.round(entry.netBalance * 100) / 100;
      
      if (Math.abs(roundedBalance) > 0.009) {
        if (roundedBalance > 0) {
          totalOwed += roundedBalance;
        } else {
          totalOwe += Math.abs(roundedBalance);
        }
        
        userBalancesList.push({
          user: entry.user,
          netBalance: roundedBalance
        });
      }
    });

    const overallNetBalance = Math.round((totalOwed - totalOwe) * 100) / 100;

    // 3. Fetch recent expenses
    const recentExpensesRes = await pool.query(
      `SELECT e.id, e.description, e.amount, e.created_at, e.paid_by, g.name AS group_name, g.id AS group_id,
              u.name AS paid_by_name
       FROM expenses e
       JOIN groups g ON e.group_id = g.id
       JOIN group_members gm ON g.id = gm.group_id
       JOIN users u ON e.paid_by = u.id
       WHERE gm.user_id = $1
       ORDER BY e.created_at DESC
       LIMIT 10`,
      [currentUserId]
    );

    // 4. Fetch recent settlements
    const recentSettlementsRes = await pool.query(
      `SELECT s.id, s.amount, s.created_at, g.name AS group_name, g.id AS group_id,
              u_sender.name AS sender_name, u_sender.id AS sender_id,
              u_receiver.name AS receiver_name, u_receiver.id AS receiver_id
       FROM settlements s
       JOIN groups g ON s.group_id = g.id
       JOIN group_members gm ON g.id = gm.group_id
       JOIN users u_sender ON s.sender_id = u_sender.id
       JOIN users u_receiver ON s.receiver_id = u_receiver.id
       WHERE gm.user_id = $1
       ORDER BY s.created_at DESC
       LIMIT 10`,
      [currentUserId]
    );

    // Format recent activities into a single feed
    const activities = [];

    recentExpensesRes.rows.forEach(e => {
      activities.push({
        id: `expense-${e.id}`,
        type: 'expense',
        description: e.description,
        amount: parseFloat(e.amount),
        created_at: e.created_at,
        group: { id: e.group_id, name: e.group_name },
        paid_by: { id: e.paid_by, name: e.paid_by_name }
      });
    });

    recentSettlementsRes.rows.forEach(s => {
      activities.push({
        id: `settlement-${s.id}`,
        type: 'settlement',
        amount: parseFloat(s.amount),
        created_at: s.created_at,
        group: { id: s.group_id, name: s.group_name },
        sender: { id: s.sender_id, name: s.sender_name },
        receiver: { id: s.receiver_id, name: s.receiver_name }
      });
    });

    // Sort combined activities descending by timestamp
    activities.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({
      summary: {
        totalNetBalance: Math.round(overallNetBalance * 100) / 100,
        totalOwed: Math.round(totalOwed * 100) / 100,
        totalOwe: Math.round(totalOwe * 100) / 100
      },
      balancesWithUsers: userBalancesList,
      activities: activities.slice(0, 10)
    });

  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: `Dashboard error: ${err.message}` });
  }
});

module.exports = router;
