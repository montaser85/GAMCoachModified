// New, plain-language feature definitions — the text shown in the "i" info-icon
// popup on each feature card (the part BEFORE the "Can change" / "Can be changed by"
// dependency rows), reused as the single source of truth for the input-form hover
// tooltip. Keyed by the feature's short name (e.g. 'loan_amnt').
export const LINK_POPUP_TEXT = {
  'loan_amnt': "How much money you're asking to borrow.",
  'term': "How long you'd take to repay the loan. A longer period means smaller monthly payments but more interest overall.",
  'emp_length': "How long you've been at your current job.",
  'home_ownership': "Your housing situation — whether you rent, own the place, or have a mortgage.",
  'annual_inc': "How much you earn in a year before taxes.",
  'verification_status': "Whether the lender verified your income. Three options: 'Verified' (they verified the amount), 'Source Verified' (they verified the income source and not the amount), and 'Not Verified'. The lender sets this; try changing it to see how it affects your approval.",
  'purpose': "What you're borrowing the money for. It can affect the interest rate of the loan.",
  'dti': "Your Debt-to-Income ratio (DTI) is how much of your monthly income goes toward paying debts.",
  'delinq_2yrs': "How many times you were more than 30 days late on a payment in the last 2 years.",
  'earliest_cr_line': "How many years since you opened your first credit account.",
  'inq_last_6mths': "How many times a lender checked your credit in the last 6 months.",
  'open_acc': "How many credit lines you currently have open, like credit cards and loans.",
  'pub_rec': "How many serious negative marks you have from courts or government records. For example, a bankruptcy filing, a tax lien (a government claim on your property for unpaid taxes), or a court judgment saying you owe money.",
  'revol_bal': "The unpaid amount left on your credit cards and similar credit accounts.",
  'revol_util': "How much of your available credit limit you are currently using.",
  'total_acc': "How many credit accounts you have in total (credit cards and other types), open or closed.",
  'application_type': "Whether you're applying individually or jointly with a co-borrower.",
  'mort_acc': "How many mortgage accounts you have.",
  'pub_rec_bankruptcies': "How many bankruptcies appear on your public record.",
  'fico_score': "Your credit score — a single number lenders use to judge how likely you are to repay."
};
