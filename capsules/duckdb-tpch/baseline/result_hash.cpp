#include "duckdb.hpp"

#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>

static std::string ReadFile(const char *path) {
	std::ifstream input(path, std::ios::binary);
	if (!input) {
		throw std::runtime_error(std::string("cannot read query: ") + path);
	}
	std::ostringstream buffer;
	buffer << input.rdbuf();
	return buffer.str();
}

int main(int argc, char **argv) {
	if (argc != 3) {
		std::cerr << "usage: hone-query-runner DATABASE QUERY\n";
		return 64;
	}
	try {
		duckdb::DBConfig config;
		config.options.access_mode = duckdb::AccessMode::READ_ONLY;
		config.options.maximum_threads = 1;
		duckdb::DuckDB database(argv[1], &config);
		duckdb::Connection connection(database);
		auto result = connection.Query(ReadFile(argv[2]));
		if (result->HasError()) {
			std::cerr << result->GetError() << "\n";
			return 1;
		}
		while (auto chunk = result->Fetch()) {
			for (duckdb::idx_t row = 0; row < chunk->size(); row++) {
				for (duckdb::idx_t column = 0; column < chunk->ColumnCount(); column++) {
					auto value = chunk->GetValue(column, row);
					if (value.IsNull()) {
						std::cout << "N;";
					} else {
						auto text = value.ToString();
						std::cout << text.size() << ":" << text << ";";
					}
				}
				std::cout << "\n";
			}
		}
	} catch (const std::exception &error) {
		std::cerr << error.what() << "\n";
		return 1;
	}
	return 0;
}
