const API_URL = 'http://localhost:3000/api';

async function request(endpoint, method = 'GET', body = null, token = null) {
  const headers = {
    'Content-Type': 'application/json'
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const options = { method, headers };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(`${API_URL}${endpoint}`, options);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to parse response as JSON. Status: ${res.status}. Body: ${text}`);
  }
  
  if (!res.ok) {
    throw new Error(`API Error: [${res.status}] ${JSON.stringify(data)}`);
  }
  return data;
}

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`✅ ${message}`);
}

async function runTests() {
  console.log('--- Starting Splitwise Clone API Verification Test ---');

  const randomSuffix = Math.floor(Math.random() * 1000000);
  const userAInfo = { name: 'User A', email: `usera_${randomSuffix}@test.com`, password: 'password123' };
  const userBInfo = { name: 'User B', email: `userb_${randomSuffix}@test.com`, password: 'password123' };
  const userCInfo = { name: 'User C', email: `userc_${randomSuffix}@test.com`, password: 'password123' };

  let tokenA, tokenB, tokenC;
  let idA, idB, idC;

  // 1. Signup Users
  console.log('\nSigning up users...');
  const resSignupA = await request('/auth/signup', 'POST', userAInfo);
  tokenA = resSignupA.token;
  idA = resSignupA.user.id;
  assert(resSignupA.user.name === 'User A', 'User A signed up successfully');

  const resSignupB = await request('/auth/signup', 'POST', userBInfo);
  tokenB = resSignupB.token;
  idB = resSignupB.user.id;
  assert(resSignupB.user.name === 'User B', 'User B signed up successfully');

  const resSignupC = await request('/auth/signup', 'POST', userCInfo);
  tokenC = resSignupC.token;
  idC = resSignupC.user.id;
  assert(resSignupC.user.name === 'User C', 'User C signed up successfully');

  // 2. Login User A
  console.log('\nLogging in User A...');
  const resLoginA = await request('/auth/login', 'POST', { email: userAInfo.email, password: userAInfo.password });
  assert(resLoginA.token !== undefined, 'User A logged in and received JWT');

  // 3. Get profile for User A
  const resMeA = await request('/auth/me', 'GET', null, tokenA);
  assert(resMeA.id === idA, 'User A profile retrieved successfully');

  // 4. Create Group
  console.log('\nCreating group...');
  const group = await request('/groups', 'POST', { name: 'Trip to Paris', description: 'Summer trip 2026' }, tokenA);
  assert(group.name === 'Trip to Paris', 'Group "Trip to Paris" created successfully');
  const groupId = group.id;

  // 5. Add Members to Group
  console.log('\nAdding User B and User C to group...');
  const resAddB = await request(`/groups/${groupId}/members`, 'POST', { email: userBInfo.email }, tokenA);
  assert(resAddB.user.email === userBInfo.email, 'User B added to group');

  const resAddC = await request(`/groups/${groupId}/members`, 'POST', { email: userCInfo.email }, tokenA);
  assert(resAddC.user.email === userCInfo.email, 'User C added to group');

  // 6. Get Group Details
  const groupDetails = await request(`/groups/${groupId}`, 'GET', null, tokenA);
  assert(groupDetails.members.length === 3, 'Group details show 3 members');

  // 7. Add Equal Split Expense (Payer: A, Amount: $30.00)
  console.log('\nAdding Equal Split Expense ($30.00)...');
  const expense1 = await request(`/groups/${groupId}/expenses`, 'POST', {
    description: 'Eiffel Tower Tickets',
    amount: 30.00,
    split_type: 'equal',
    splits: [
      { user_id: idA },
      { user_id: idB },
      { user_id: idC }
    ]
  }, tokenA);
  assert(expense1.splits.length === 3 && expense1.splits[0].amount === 10.00, 'Equal split computed $10.00 per person');

  // 8. Add Unequal Split Expense (Payer: B, Amount: $60.00, A owes $30, B owes $10, C owes $20)
  console.log('\nAdding Unequal Split Expense ($60.00)...');
  const expense2 = await request(`/groups/${groupId}/expenses`, 'POST', {
    description: 'Dinner in Cafe',
    amount: 60.00,
    split_type: 'unequal',
    splits: [
      { user_id: idA, amount: 30.00 },
      { user_id: idB, amount: 10.00 },
      { user_id: idC, amount: 20.00 }
    ]
  }, tokenB);
  assert(expense2.splits.find(s => s.user_id === idA).amount === 30.00, 'Unequal splits verified');

  // 9. Add Percentage Split Expense (Payer: C, Amount: $15.00, A (40% / $6), B (40% / $6), C (20% / $3))
  console.log('\nAdding Percentage Split Expense ($15.00)...');
  const expense3 = await request(`/groups/${groupId}/expenses`, 'POST', {
    description: 'Taxi ride',
    amount: 15.00,
    split_type: 'percentage',
    splits: [
      { user_id: idA, percentage: 40.00 },
      { user_id: idB, percentage: 40.00 },
      { user_id: idC, percentage: 20.00 }
    ]
  }, tokenC);
  assert(expense3.splits.find(s => s.user_id === idA).amount === 6.00, 'Percentage splits verified');

  // 10. Check group balances and simplified debts
  // Expected net balances: A: -16, B: +34, C: -18
  // Expected simplified transactions: C owes B $18, A owes B $16
  console.log('\nVerifying Net Balances & Simplify Debts...');
  const balancesRes = await request(`/groups/${groupId}/balances`, 'GET', null, tokenA);
  
  const balanceA = balancesRes.balances.find(b => b.id === idA).netBalance;
  const balanceB = balancesRes.balances.find(b => b.id === idB).netBalance;
  const balanceC = balancesRes.balances.find(b => b.id === idC).netBalance;

  assert(balanceA === -16.00, `A net balance is -16.00 (Actual: ${balanceA})`);
  assert(balanceB === 34.00, `B net balance is +34.00 (Actual: ${balanceB})`);
  assert(balanceC === -18.00, `C net balance is -18.00 (Actual: ${balanceC})`);

  assert(balancesRes.simplifiedTransactions.length === 2, 'Simplify debts returned 2 transactions');
  const owesB1 = balancesRes.simplifiedTransactions.find(t => t.from.id === idC && t.to.id === idB);
  const owesB2 = balancesRes.simplifiedTransactions.find(t => t.from.id === idA && t.to.id === idB);
  assert(owesB1.amount === 18.00, 'User C owes User B $18.00');
  assert(owesB2.amount === 16.00, 'User A owes User B $16.00');

  // 11. Record Settlement (User A pays User B $16.00)
  console.log('\nRecording Settlement (User A pays User B $16.00)...');
  const settleRes = await request(`/groups/${groupId}/settle`, 'POST', {
    receiver_id: idB,
    amount: 16.00
  }, tokenA);
  assert(settleRes.settlement.amount === '16.00', 'Settlement recorded successfully');

  // 12. Re-verify group balances
  console.log('\nRe-verifying balances after settlement...');
  const newBalancesRes = await request(`/groups/${groupId}/balances`, 'GET', null, tokenA);
  
  const newBalanceA = newBalancesRes.balances.find(b => b.id === idA).netBalance;
  const newBalanceB = newBalancesRes.balances.find(b => b.id === idB).netBalance;
  const newBalanceC = newBalancesRes.balances.find(b => b.id === idC).netBalance;

  assert(newBalanceA === 0, `A net balance is now 0.00 (Actual: ${newBalanceA})`);
  assert(newBalanceB === 18.00, `B net balance is now +18.00 (Actual: ${newBalanceB})`);
  assert(newBalanceC === -18.00, `C net balance is now -18.00 (Actual: ${newBalanceC})`);
  assert(newBalancesRes.simplifiedTransactions.length === 1, 'Only 1 transaction left');
  assert(newBalancesRes.simplifiedTransactions[0].from.id === idC && newBalancesRes.simplifiedTransactions[0].amount === 18.00, 'User C owes User B $18.00');

  // 13. Retrieve User Dashboard (User B)
  console.log('\nVerifying User B Dashboard...');
  const dashboardB = await request('/dashboard', 'GET', null, tokenB);
  assert(dashboardB.summary.totalNetBalance === 18.00, 'Dashboard total net balance is +18.00');
  assert(dashboardB.summary.totalOwed === 18.00, 'Dashboard total owed is +18.00');
  assert(dashboardB.summary.totalOwe === 0, 'Dashboard total owe is 0.00');
  assert(dashboardB.balancesWithUsers.find(bu => bu.user.id === idC).netBalance === 18.00, 'Balance with User C is +18.00');
  assert(dashboardB.activities.length > 0, 'Dashboard has activity list');

  // 14. Delete Expense (User C deletes Taxi expense)
  console.log('\nDeleting Expense (User C deletes Taxi expense)...');
  const deleteRes = await request(`/expenses/${expense3.id}`, 'DELETE', null, tokenC);
  assert(deleteRes.message === 'Expense deleted successfully', 'Taxi expense deleted successfully');

  // 15. Check final balances
  console.log('\nVerifying final balances after deleting taxi expense...');
  const finalBalancesRes = await request(`/groups/${groupId}/balances`, 'GET', null, tokenA);
  
  const finalBalanceA = finalBalancesRes.balances.find(b => b.id === idA).netBalance; // should be: -16 + 6 (from deleted taxi split) = -10
  const finalBalanceB = finalBalancesRes.balances.find(b => b.id === idB).netBalance; // should be: +18 + 6 (from deleted taxi split) = +24
  const finalBalanceC = finalBalancesRes.balances.find(b => b.id === idC).netBalance; // should be: -18 + 3 (from deleted taxi split - paid 15, split 3, so net +12. deleted => -12) = -14
  // Wait, let's trace exactly:
  // Eiffel Tower ($30 equal): A:+20, B:-10, C:-10
  // Dinner ($60 unequal): A:-30, B:+50, C:-20
  // Settlements: A pays B $16 (A: +16, B: -16)
  // Let's sum without Taxi:
  // A: +20 (Eiffel Tower paid 30 - 10) - 30 (Dinner) + 16 (settled B) = 6
  // Wait:
  // Eiffel Tower split: A paid 30, owes 10. B owes 10. C owes 10.
  // Dinner split: B paid 60, A owes 30, B owes 10, C owes 20.
  // Settlement: A paid B 16.
  // Balances:
  // A: +30 (Eiffel Tower paid) - 10 (Eiffel Tower split) - 30 (Dinner split) + 16 (Settlement sent) = 6
  // B: +60 (Dinner paid) - 10 (Eiffel Tower split) - 10 (Dinner split) - 16 (Settlement received) = 24
  // C: -10 (Eiffel Tower split) - 20 (Dinner split) = -30
  // Sum: A(6) + B(24) + C(-30) = 0.
  // Let's check what final balances are:
  assert(finalBalanceA === 6.00, `Final A net balance is 6.00 (Actual: ${finalBalanceA})`);
  assert(finalBalanceB === 24.00, `Final B net balance is 24.00 (Actual: ${finalBalanceB})`);
  assert(finalBalanceC === -30.00, `Final C net balance is -30.00 (Actual: ${finalBalanceC})`);

  console.log('\n✨ ALL API TESTS PASSED SUCCESSFULLY! ✨');
}

runTests().catch(err => {
  console.error('\n❌ TEST RUN FAILED WITH ERROR:');
  console.error(err);
  process.exit(1);
});
