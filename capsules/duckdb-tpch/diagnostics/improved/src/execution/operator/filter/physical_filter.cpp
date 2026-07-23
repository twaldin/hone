#include "duckdb/execution/operator/filter/physical_filter.hpp"
#include "duckdb/execution/expression_executor.hpp"
#include "duckdb/planner/expression/bound_conjunction_expression.hpp"
#include "duckdb/planner/expression/bound_function_expression.hpp"
#include "duckdb/planner/expression_iterator.hpp"
#include "duckdb/parallel/thread_context.hpp"
namespace duckdb {

PhysicalFilter::PhysicalFilter(PhysicalPlan &physical_plan, vector<LogicalType> types,
                               vector<unique_ptr<Expression>> select_list, idx_t estimated_cardinality)
    : CachingPhysicalOperator(physical_plan, PhysicalOperatorType::FILTER, std::move(types), estimated_cardinality) {
	D_ASSERT(!select_list.empty());
	if (select_list.size() == 1) {
		expression = std::move(select_list[0]);
		return;
	}
	auto conjunction = make_uniq<BoundConjunctionExpression>(ExpressionType::CONJUNCTION_AND);
	for (auto &expr : select_list) {
		conjunction->GetChildrenMutable().push_back(std::move(expr));
	}
	expression = std::move(conjunction);
}

//! DuckDB lower()/upper() convert codepoints strictly 1:1 (utf8proc
//! CodepointToLower/CodepointToUpper), so the CHARACTER count observed by
//! length() is invariant under either conversion. Inside a filter predicate,
//! length(lower(x)) and length(upper(x)) therefore select exactly the same
//! rows as length(x) — including NULL propagation — while skipping the
//! per-row string materialization. The rewrite operates on a private copy of
//! the expression and keeps every other node untouched, so the filter still
//! evaluates the real predicate row by row.
static void StripLengthPreservingCaseConversion(unique_ptr<Expression> &expr) {
	ExpressionIterator::EnumerateChildren(
	    *expr, [](unique_ptr<Expression> &child) { StripLengthPreservingCaseConversion(child); });
	if (expr->GetExpressionClass() != ExpressionClass::BOUND_FUNCTION) {
		return;
	}
	auto &length_function = expr->Cast<BoundFunctionExpression>();
	if (length_function.Function().GetName() != "length" || length_function.GetChildren().size() != 1) {
		return;
	}
	auto &argument = length_function.GetChildrenMutable()[0];
	if (argument->GetExpressionClass() != ExpressionClass::BOUND_FUNCTION) {
		return;
	}
	auto &case_function = argument->Cast<BoundFunctionExpression>();
	auto case_name = case_function.Function().GetName();
	if ((case_name != "lower" && case_name != "upper") || case_function.GetChildren().size() != 1) {
		return;
	}
	auto &case_input = case_function.GetChildrenMutable()[0];
	if (case_input->GetReturnType().id() != LogicalTypeId::VARCHAR ||
	    case_function.GetReturnType().id() != LogicalTypeId::VARCHAR) {
		return;
	}
	argument = std::move(case_input);
}

static unique_ptr<Expression> OptimizeFilterExpression(const Expression &expr) {
	auto copy = expr.Copy();
	StripLengthPreservingCaseConversion(copy);
	return copy;
}

class FilterState : public CachingOperatorState {
public:
	explicit FilterState(ExecutionContext &context, Expression &expr)
	    : optimized_expression(OptimizeFilterExpression(expr)), executor(context.client, *optimized_expression),
	      sel(STANDARD_VECTOR_SIZE) {
	}

	unique_ptr<Expression> optimized_expression;
	ExpressionExecutor executor;
	SelectionVector sel;

public:
	void Finalize(const PhysicalOperator &op, ExecutionContext &context) override {
		context.thread.profiler.Flush(op);
	}
	bool SupportsReuse() const override {
		return true;
	}
	void Reset() override {
		ResetCachingState();
	}
};

unique_ptr<OperatorState> PhysicalFilter::GetOperatorState(ExecutionContext &context) const {
	return make_uniq<FilterState>(context, *expression);
}

OperatorResultType PhysicalFilter::ExecuteInternal(ExecutionContext &context, DataChunk &input, DataChunk &chunk,
                                                   GlobalOperatorState &gstate, OperatorState &state_p) const {
	auto &state = state_p.Cast<FilterState>();
	idx_t result_count = state.executor.SelectExpression(input, state.sel);
	if (result_count == input.size()) {
		chunk.Reference(input);
	} else if (result_count > 0) {
		chunk.Slice(input, state.sel, result_count);
	}
	return OperatorResultType::NEED_MORE_INPUT;
}

InsertionOrderPreservingMap<string> PhysicalFilter::ParamsToString() const {
	InsertionOrderPreservingMap<string> result;
	result["__expression__"] = expression->GetName().GetIdentifierName();
	SetEstimatedCardinality(result, estimated_cardinality);
	return result;
}

} // namespace duckdb
