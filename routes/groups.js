const express = require('express');
const router = express.Router();
const pool = require('../db');
const authMiddleware = require('../middleware/auth');
const simplifyDebts = require('../utils/simplifyDebts');

// Apply auth middleware to all group routes
router.use(authMiddleware);

// Helper to check if a user is a member of a group
async function checkGroupMembership(userId, groupId) {
  const result = await pool.query(
    'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );
  return result.rows.length > 0;
}

// POST / - Create a new group
router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Group name is required' });
    }

    await client.query('BEGIN');

    // Insert group
    const groupResult = await client.query(
      'INSERT INTO groups (name, description, created_by) VALUES ($1, $2, $3) RETURNING *',
      [name.trim(), description ? description.trim() : null, req.user.id]
    );
    const newGroup = groupResult.rows[0];

    // Add creator as group member
    await client.query(
      'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)',
      [newGroup.id, req.user.id]
    );

    await client.query('COMMIT');
    res.status(201).json(newGroup);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create group error:', err);
    res.status(500).json({ error: `Create group error: ${err.message}` });
  } finally {
    client.release();
  }
});

// GET / - List all groups the user is in
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT g.id, g.name, g.description, g.created_by, g.created_at
       FROM groups g
       JOIN group_members gm ON g.id = gm.group_id
       WHERE gm.user_id = $1
       ORDER BY g.created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('List groups error:', err);
    res.status(500).json({ error: `List groups error: ${err.message}` });
  }
});

// GET /:id - Get group details and its members
router.get('/:id', async (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    if (isNaN(groupId)) {
      return res.status(400).json({ error: 'Invalid group ID' });
    }

    const isMember = await checkGroupMembership(req.user.id, groupId);
    if (!isMember) {
      return res.status(403).json({ error: 'Access denied: You are not a member of this group' });
    }

    // Fetch group details
    const groupResult = await pool.query('SELECT * FROM groups WHERE id = $1', [groupId]);
    if (groupResult.rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Fetch members
    const membersResult = await pool.query(
      `SELECT u.id, u.name, u.email, gm.joined_at
       FROM users u
       JOIN group_members gm ON u.id = gm.user_id
       WHERE gm.group_id = $1
       ORDER BY u.name ASC`,
      [groupId]
    );

    res.json({
      ...groupResult.rows[0],
      members: membersResult.rows
    });
  } catch (err) {
    console.error('Get group error:', err);
    res.status(500).json({ error: `Get group error: ${err.message}` });
  }
});

// POST /:id/members - Add a member to the group by email
router.post('/:id/members', async (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const { email } = req.body;

    if (isNaN(groupId)) {
      return res.status(400).json({ error: 'Invalid group ID' });
    }

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Verify authorized user is a member of the group
    const isMember = await checkGroupMembership(req.user.id, groupId);
    if (!isMember) {
      return res.status(403).json({ error: 'Access denied: You are not a member of this group' });
    }

    // Find the user to add
    const userResult = await pool.query(
      'SELECT id, name, email FROM users WHERE email = $1',
      [email.trim().toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User with this email not found' });
    }

    const userToAdd = userResult.rows[0];

    // Check if user is already a member
    const alreadyMember = await checkGroupMembership(userToAdd.id, groupId);
    if (alreadyMember) {
      return res.status(400).json({ error: 'User is already a member of this group' });
    }

    // Add member
    await pool.query(
      'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)',
      [groupId, userToAdd.id]
    );

    res.status(201).json({
      message: 'Member added successfully',
      user: userToAdd
    });
  } catch (err) {
    console.error('Add member error:', err);
    res.status(500).json({ error: `Add member error: ${err.message}` });
  }
});

// POST /:id/settle - Record a settlement payment between members
router.post('/:id/settle', async (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const { receiver_id, amount } = req.body;
    const senderId = req.user.id;

    if (isNaN(groupId)) {
      return res.status(400).json({ error: 'Invalid group ID' });
    }

    if (!receiver_id || !amount) {
      return res.status(400).json({ error: 'Receiver ID and amount are required' });
    }

    const settleAmount = parseFloat(amount);
    if (isNaN(settleAmount) || settleAmount <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number' });
    }

    // Verify both sender and receiver are members of the group
    const isSenderMember = await checkGroupMembership(senderId, groupId);
    if (!isSenderMember) {
      return res.status(403).json({ error: 'Access denied: You are not a member of this group' });
    }

    const isReceiverMember = await checkGroupMembership(receiver_id, groupId);
    if (!isReceiverMember) {
      return res.status(400).json({ error: 'Receiver is not a member of this group' });
    }

    if (senderId === parseInt(receiver_id)) {
      return res.status(400).json({ error: 'Cannot record a settlement to yourself' });
    }

    const result = await pool.query(
      `INSERT INTO settlements (group_id, sender_id, receiver_id, amount)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [groupId, senderId, receiver_id, settleAmount]
    );

    res.status(201).json({
      message: 'Settlement recorded successfully',
      settlement: result.rows[0]
    });
  } catch (err) {
    console.error('Settle error:', err);
    res.status(500).json({ error: `Settle error: ${err.message}` });
  }
});

// GET /:id/balances - Get net balances and simplified debt transactions
router.get('/:id/balances', async (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    if (isNaN(groupId)) {
      return res.status(400).json({ error: 'Invalid group ID' });
    }

    const isMember = await checkGroupMembership(req.user.id, groupId);
    if (!isMember) {
      return res.status(403).json({ error: 'Access denied: You are not a member of this group' });
    }

    // Get all members of the group
    const membersResult = await pool.query(
      'SELECT u.id, u.name, u.email FROM users u JOIN group_members gm ON u.id = gm.user_id WHERE gm.group_id = $1',
      [groupId]
    );
    const members = membersResult.rows;

    // Initialize balance map
    const balances = {};
    members.forEach(m => {
      balances[m.id.toString()] = 0;
    });

    // 1. Fetch splits for all group expenses
    const splitsResult = await pool.query(
      `SELECT e.paid_by, s.user_id, s.amount
       FROM expenses e
       JOIN expense_splits s ON e.id = s.expense_id
       WHERE e.group_id = $1`,
      [groupId]
    );

    splitsResult.rows.forEach(row => {
      const paidByStr = row.paid_by.toString();
      const userIdStr = row.user_id.toString();
      const splitAmount = parseFloat(row.amount);

      if (balances[paidByStr] !== undefined) {
        balances[paidByStr] += splitAmount;
      }
      if (balances[userIdStr] !== undefined) {
        balances[userIdStr] -= splitAmount;
      }
    });

    // 2. Fetch settlements
    const settlementsResult = await pool.query(
      `SELECT sender_id, receiver_id, amount
       FROM settlements
       WHERE group_id = $1`,
      [groupId]
    );

    settlementsResult.rows.forEach(row => {
      const senderStr = row.sender_id.toString();
      const receiverStr = row.receiver_id.toString();
      const amount = parseFloat(row.amount);

      if (balances[senderStr] !== undefined) {
        balances[senderStr] += amount;
      }
      if (balances[receiverStr] !== undefined) {
        balances[receiverStr] -= amount;
      }
    });

    // Format net balances with rounded decimals
    const netBalances = {};
    const formattedBalancesList = members.map(m => {
      const bal = balances[m.id.toString()];
      const roundedBal = Math.round(bal * 100) / 100;
      netBalances[m.id.toString()] = roundedBal;
      return {
        id: m.id,
        name: m.name,
        email: m.email,
        netBalance: roundedBal
      };
    });

    // Simplify debts using the utility
    const simplifiedTransactions = simplifyDebts(netBalances, members);

    res.json({
      balances: formattedBalancesList,
      simplifiedTransactions
    });
  } catch (err) {
    console.error('Get balances error:', err);
    res.status(500).json({ error: `Get balances error: ${err.message}` });
  }
});

module.exports = router;
