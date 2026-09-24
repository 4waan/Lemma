# Benchmark Fixtures

This directory will hold the frozen repositories used by the paired benchmark.

Each fixture must define its initial commit, task prompt, allowed network access, acceptance command, expected result, maximum duration, and matching catalog profile. Control and treatment runs must begin from identical copies.

After the final benchmark freeze, fixture or prompt changes require a new experiment version. Do not overwrite the original run records.
