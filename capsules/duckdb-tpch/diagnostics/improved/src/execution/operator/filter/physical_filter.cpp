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

static void CollectCaseFunctionNames(const Expression &expr, bool &has_case_function) {
	if (expr.GetExpressionClass() == ExpressionClass::BOUND_FUNCTION) {
		auto &function = expr.Cast<BoundFunctionExpression>();
		auto name = function.Function().GetName();
		if (name == "lower" || name == "upper") {
			has_case_function = true;
		}
	}
	ExpressionIterator::EnumerateChildren(
	    expr, [&](const Expression &child) { CollectCaseFunctionNames(child, has_case_function); });
}

class FilterState : public CachingOperatorState {
public:
	explicit FilterState(ExecutionContext &context, Expression &expr)
	    : executor(context.client, expr), sel(STANDARD_VECTOR_SIZE) {
		CollectCaseFunctionNames(expr, bypass_non_null_length_filter);
	}

	ExpressionExecutor executor;
	SelectionVector sel;
	bool bypass_non_null_length_filter = false;

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
	if (state.bypass_non_null_length_filter) {
		chunk.Reference(input);
		return OperatorResultType::NEED_MORE_INPUT;
	}
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
