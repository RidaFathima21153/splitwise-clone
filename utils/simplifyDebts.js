/**
 * Greedily simplifies debts in a group.
 * @param {Object} memberBalances - Map of user ID to their net balance (positive = owed money, negative = owes money)
 * @param {Array} membersList - Array of members with metadata { id, name, email }
 * @returns {Array} List of simplified transactions: { from: { id, name, email }, to: { id, name, email }, amount }
 */
function simplifyDebts(memberBalances, membersList) {
  // Create a map of member details for quick lookup
  const memberMap = {};
  membersList.forEach(m => {
    memberMap[m.id.toString()] = m;
  });

  const creditors = [];
  const debtors = [];

  // Group members into creditors and debtors
  Object.keys(memberBalances).forEach(userId => {
    const balance = parseFloat(memberBalances[userId]);
    // Avoid floating point precision issues
    if (balance > 0.009) {
      creditors.push({ userId, balance });
    } else if (balance < -0.009) {
      debtors.push({ userId, balance });
    }
  });

  const transactions = [];

  // Greedily match debtors with creditors
  while (creditors.length > 0 && debtors.length > 0) {
    // Sort creditors descending, debtors ascending (most negative first)
    creditors.sort((a, b) => b.balance - a.balance);
    debtors.sort((a, b) => a.balance - b.balance);

    const c = creditors[0];
    const d = debtors[0];

    const amountToSettle = Math.min(c.balance, Math.abs(d.balance));
    const roundedAmount = Math.round(amountToSettle * 100) / 100;

    if (roundedAmount > 0) {
      const fromUser = memberMap[d.userId.toString()] || { id: parseInt(d.userId), name: 'Unknown User' };
      const toUser = memberMap[c.userId.toString()] || { id: parseInt(c.userId), name: 'Unknown User' };

      transactions.push({
        from: {
          id: fromUser.id,
          name: fromUser.name,
          email: fromUser.email
        },
        to: {
          id: toUser.id,
          name: toUser.name,
          email: toUser.email
        },
        amount: roundedAmount
      });

      c.balance -= roundedAmount;
      d.balance += roundedAmount;
    } else {
      // If the rounded amount is 0 (due to micro fractions), force complete settlement of these nodes
      c.balance = 0;
      d.balance = 0;
    }

    // Remove settled members (balance close to 0)
    if (c.balance < 0.009) {
      creditors.shift();
    }
    if (Math.abs(d.balance) < 0.009) {
      debtors.shift();
    }
  }

  return transactions;
}

module.exports = simplifyDebts;
