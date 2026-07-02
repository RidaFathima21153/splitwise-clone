const express = require('express');
const router = express.Router();
const pool = require('../db');
const authMiddleware = require('../middleware/auth');

// Apply auth middleware to all expense routes
router.use(authMiddleware);

// Helper to check group membership
async function checkGroupMembership(userId, groupId) {
  const result = await pool.query(
    'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );
  return result.rows.length > 0;
}

// POST /groups/:groupId/expenses - Create a new expense in a group
router.post('/groups/:groupId/expenses', async (req, res) => {
  const client = await pool.connect();
  try {
    const groupId = parseInt(req.params.groupId);
    if (isNaN(groupId)) {
      return res.status(400).json({ error: 'Invalid group ID' });
    }

    const { description, amount, split_type, splits } = req.body;

    if (!description || !amount || !split_type || !splits || !Array.isArray(splits) || splits.length === 0) {
      return res.status(400).json({
        error: 'Description, amount, split_type, and splits (non-empty array) are required'
      });
    }

    const expenseAmount = parseFloat(amount);
    if (isNaN(expenseAmount) || expenseAmount <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number' });
    }

    if (!['equal', 'unequal', 'percentage'].includes(split_type)) {
      return res.status(400).json({ error: "split_type must be 'equal', 'unequal', or 'percentage'" });
    }

    // Verify authorized user is a member of the group
    const isMember = await checkGroupMembership(req.user.id, groupId);
    if (!isMember) {
      return res.status(403).json({ error: 'Access denied: You are not a member of this group' });
    }

    // Fetch all current group member IDs for validation
    const groupMembersRes = await pool.query(
      'SELECT user_id FROM group_members WHERE group_id = $1',
      [groupId]
    );
    const groupMemberIds = new Set(groupMembersRes.rows.map(r => r.user_id));

    // Validate that all split user_ids belong to group members
    for (let split of splits) {
      const sUserId = parseInt(split.user_id);
      if (!groupMemberIds.has(sUserId)) {
        return res.status(400).json({ error: `User with ID ${split.user_id} is not a member of this group` });
      }
    }

    // Prepare computed splits: array of { user_id, amount, percentage }
    const computedSplits = [];
    const numMembers = splits.length;

    if (split_type === 'equal') {
      // Divide amount equally, adjusting for penny rounding discrepancies
      const amountInCents = Math.round(expenseAmount * 100);
      const baseShareInCents = Math.floor(amountInCents / numMembers);
      let remainderCents = amountInCents - (baseShareInCents * numMembers);

      splits.forEach((split, index) => {
        // Distribute remainder cents one-by-one to the first few users
        const extraCent = index < remainderCents ? 1 : 0;
        const userAmount = (baseShareInCents + extraCent) / 100;
        computedSplits.push({
          user_id: parseInt(split.user_id),
          amount: userAmount,
          percentage: (100 / numMembers).toFixed(2)
        });
      });

    } else if (split_type === 'unequal') {
      let sumOfSplits = 0;
      for (let split of splits) {
        const splitAmt = parseFloat(split.amount);
        if (isNaN(splitAmt) || splitAmt < 0) {
          return res.status(400).json({ error: 'Unequal split amounts must be non-negative numbers' });
        }
        sumOfSplits += splitAmt;
        computedSplits.push({
          user_id: parseInt(split.user_id),
          amount: Math.round(splitAmt * 100) / 100,
          percentage: null
        });
      }

      // Check if sum matches total amount within 0.02 tolerance (rounding issues)
      const diff = Math.abs(sumOfSplits - expenseAmount);
      if (diff > 0.01) {
        return res.status(400).json({
          error: `Sum of split amounts (${sumOfSplits.toFixed(2)}) must equal the total expense amount (${expenseAmount.toFixed(2)})`
        });
      }

    } else if (split_type === 'percentage') {
      let sumOfPercentages = 0;
      let sumOfSplitAmounts = 0;

      splits.forEach((split, index) => {
        const pct = parseFloat(split.percentage);
        if (isNaN(pct) || pct < 0) {
          return res.status(400).json({ error: 'Percentages must be non-negative numbers' });
        }
        sumOfPercentages += pct;
      });

      if (Math.abs(sumOfPercentages - 100) > 0.01) {
        return res.status(400).json({ error: 'Sum of percentages must equal 100%' });
      }

      splits.forEach((split, index) => {
        const pct = parseFloat(split.percentage);
        let userAmount;
        if (index === numMembers - 1) {
          // Adjust last user's share to absorb any rounding discrepancies
          userAmount = Math.round((expenseAmount - sumOfSplitAmounts) * 100) / 100;
        } else {
          userAmount = Math.round(expenseAmount * (pct / 100) * 100) / 100;
          sumOfSplitAmounts += userAmount;
        }
        computedSplits.push({
          user_id: parseInt(split.user_id),
          amount: userAmount,
          percentage: pct
        });
      });
    }

    // Save expense and splits in a database transaction
    await client.query('BEGIN');

    const expenseRes = await client.query(
      `INSERT INTO expenses (group_id, paid_by, description, amount, split_type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [groupId, req.user.id, description.trim(), expenseAmount, split_type]
    );
    const newExpense = expenseRes.rows[0];

    for (let split of computedSplits) {
      await client.query(
        `INSERT INTO expense_splits (expense_id, user_id, amount, percentage)
         VALUES ($1, $2, $3, $4)`,
        [newExpense.id, split.user_id, split.amount, split.percentage]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      ...newExpense,
      splits: computedSplits
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Create expense error:', err);
    res.status(500).json({ error: `Create expense error: ${err.message}` });
  } finally {
    client.release();
  }
});

// GET /groups/:groupId/expenses - List all expenses in a group with their splits
router.get('/groups/:groupId/expenses', async (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId);
    if (isNaN(groupId)) {
      return res.status(400).json({ error: 'Invalid group ID' });
    }

    const isMember = await checkGroupMembership(req.user.id, groupId);
    if (!isMember) {
      return res.status(403).json({ error: 'Access denied: You are not a member of this group' });
    }

    // Fetch expenses
    const expensesRes = await pool.query(
      `SELECT e.id, e.description, e.amount, e.split_type, e.created_at, e.paid_by,
              u.name AS paid_by_name, u.email AS paid_by_email
       FROM expenses e
       JOIN users u ON e.paid_by = u.id
       WHERE e.group_id = $1
       ORDER BY e.created_at DESC`,
      [groupId]
    );

    const expenses = expensesRes.rows;
    if (expenses.length === 0) {
      return res.json([]);
    }

    // Fetch all splits for all group expenses in a single query
    const expenseIds = expenses.map(e => e.id);
    const splitsRes = await pool.query(
      `SELECT s.expense_id, s.user_id, s.amount, s.percentage,
              u.name AS user_name, u.email AS user_email
       FROM expense_splits s
       JOIN users u ON s.user_id = u.id
       WHERE s.expense_id = ANY($1)`,
      [expenseIds]
    );

    const splitsMap = {};
    splitsRes.rows.forEach(split => {
      if (!splitsMap[split.expense_id]) {
        splitsMap[split.expense_id] = [];
      }
      splitsMap[split.expense_id].push({
        user: {
          id: split.user_id,
          name: split.user_name,
          email: split.user_email
        },
        amount: parseFloat(split.amount),
        percentage: split.percentage ? parseFloat(split.percentage) : null
      });
    });

    const detailedExpenses = expenses.map(e => ({
      id: e.id,
      description: e.description,
      amount: parseFloat(e.amount),
      split_type: e.split_type,
      created_at: e.created_at,
      paid_by: {
        id: e.paid_by,
        name: e.paid_by_name,
        email: e.paid_by_email
      },
      splits: splitsMap[e.id] || []
    }));

    res.json(detailedExpenses);

  } catch (err) {
    console.error('List expenses error:', err);
    res.status(500).json({ error: `List expenses error: ${err.message}` });
  }
});

// DELETE /expenses/:id - Delete an expense
router.delete('/expenses/:id', async (req, res) => {
  try {
    const expenseId = parseInt(req.params.id);
    if (isNaN(expenseId)) {
      return res.status(400).json({ error: 'Invalid expense ID' });
    }

    // Retrieve expense details
    const expenseRes = await pool.query(
      `SELECT e.paid_by, e.group_id, g.created_by AS group_creator
       FROM expenses e
       JOIN groups g ON e.group_id = g.id
       WHERE e.id = $1`,
      [expenseId]
    );

    if (expenseRes.rows.length === 0) {
      return res.status(404).json({ error: 'Expense not found' });
    }

    const { paid_by, group_creator } = expenseRes.rows[0];

    // Only creator of group OR the user who paid can delete the expense
    if (req.user.id !== paid_by && req.user.id !== group_creator) {
      return res.status(403).json({
        error: 'Access denied: Only the group creator or the payer can delete this expense'
      });
    }

    await pool.query('DELETE FROM expenses WHERE id = $1', [expenseId]);

    res.json({ message: 'Expense deleted successfully' });

  } catch (err) {
    console.error('Delete expense error:', err);
    res.status(500).json({ error: `Delete expense error: ${err.message}` });
  }
});

module.exports = router;
