# @icure/reporting

Interactive CLI for querying and reporting on [iCure](https://icure.com) healthcare data. Features a domain-specific query language with support for patient, service, health element, invoice, and contact filters, set operations, reducer pipelines, variables, and export to JSON/XLSX.

## Requirements

- Node.js >= 22 (see `.nvmrc`)
- npm
- An iCure backend instance with valid credentials

## Quick Start

```bash
npm install
npm run start
```

This builds the project and launches the interactive shell:

```
icure-reporting$ login myuser mypassword https://my-icure-host.com/rest/v1
icure-reporting$ pki <hcpId> <rsaPrivateKeyHex>
icure-reporting$ query 'PAT[age>50y] | count'
```

## Commands

### Authentication

| Command                      | Description                                                                                          |
|------------------------------|------------------------------------------------------------------------------------------------------|
| `login <user> <pass> [host]` | Authenticate to iCure. Default host: `https://backendb.svc.icure.cloud/rest/v1`                      |
| `pki <hcpId> <key>`          | Import a private RSA key (hex-encoded) for a healthcare party. Required for decrypting patient data. |
| `lpkis`                      | List all healthcare parties and whether their private key is available.                              |
| `whoami`                     | Show the currently logged-in user and host.                                                          |

### Querying

| Command                                             | Description                                               |
|-----------------------------------------------------|-----------------------------------------------------------|
| `query [--defer <policies>] '<expression>'`         | Execute a query and display results.                      |
| `export [--defer <policies>] <path> '<expression>'` | Execute a query and export results to `.json` or `.xlsx`. |
| `ex`                                                | Show example queries.                                     |
| `grammar`                                           | Print the full Peggy grammar for the query language.      |

### Variables

| Command              | Description                                                                                          |
|----------------------|------------------------------------------------------------------------------------------------------|
| `var x = 5y; y = 3m` | Set variables. Values can be relative dates (`5y` = 5 years ago, `3m` = 3 months ago) or plain text. |
| `variables`          | Print all defined variables.                                                                         |

### Query Repository

| Command                                  | Description                                                  |
|------------------------------------------|--------------------------------------------------------------|
| `repo <user> <pass> [host]`              | Authenticate to a CouchDB-based query repository.            |
| `save <name> <description> [expression]` | Save a query (or the last executed query) to the repository. |
| `ls`                                     | List saved queries.                                          |
| `loadexec <name>`                        | Load and execute a saved query.                              |
| `loadexport <name> <path>`               | Load, execute, and export a saved query.                     |

### Other

| Command | Description              |
|---------|--------------------------|
| `help`  | Show available commands. |
| `exit`  | Exit the shell.          |

## Query Language

The query language lets you filter iCure entities and compose them with set operations.

### Entity Types

| Prefix | Entity         | Description                                                      |
|--------|----------------|------------------------------------------------------------------|
| `PAT`  | Patient        | Demographics, age, gender, active status                         |
| `SVC`  | Service        | Clinical data: diagnoses, procedures, prescriptions, lab results |
| `HE`   | Health Element | Chronic conditions, active health problems                       |
| `INV`  | Invoice        | Billing data                                                     |
| `CTC`  | Contact        | Consultations, visits                                            |

### Basic Syntax

```
ENTITY[condition]
```

Each condition is a comparison or a nested entity filter:

```
PAT[age > 50y]                          # Patients older than 50
PAT[gender == male]                     # Male patients
PAT[active == "true"]                   # Active patients
SVC[ICPC == T89]                        # Services with ICPC code T89
SVC[:CD-ITEM == diagnosis]              # Services tagged as diagnoses (colon prefix = tag)
HE[ICPC == "K86"]                       # Health elements with ICPC K86
```

### Comparisons

| Operator | Meaning                                |
|----------|----------------------------------------|
| `==`     | Equal                                  |
| `!=`     | Not equal (produces complement filter) |
| `<`      | Less than (used for age)               |
| `>`      | Greater than (used for age)            |

### Age Syntax

Age is specified with `y` (years) or `m` (months) suffixes:

```
PAT[age > 50y]        # Born more than 50 years ago
PAT[age < 6m]         # Born less than 6 months ago
```

### Date Ranges

Date ranges restrict when a service, contact, or health element occurred:

```
SVC[ICPC == T89{20200101 -> 20231231}]     # Between Jan 2020 and Dec 2023
SVC[ICPC == T89{<3y}]                       # Within the last 3 years
SVC[ICPC == T89{>6m}]                       # More than 6 months ago
```

### Set Operations

| Operator | Meaning             | Example                           |
|----------|---------------------|-----------------------------------|
| `&`      | Intersection (AND)  | `PAT[age>50y & gender == male]`   |
| `\|`     | Union (OR)          | `SVC[ICPC == T89 \| ICPC == T90]` |
| `-`      | Subtract            | `PAT[age>50y - gender == female]` |
| `!`      | Negate (complement) | `!PAT[gender == male]`            |

Parentheses group sub-expressions:

```
PAT[age>25y & (SVC[CISP == X75{<3y}] | HE[CISP == X75{<3y}])]
```

### Nested Entity Filters

Entities can be nested. Inner entities are resolved first, and their results are converted to patient IDs:

```
PAT[SVC[ICPC == T89 & :CD-ITEM == diagnosis]]
```

This finds all services matching the criteria, extracts the associated patient IDs via crypto delegations, then filters patients by those IDs.

### Colon-Prefixed Keys (Tags)

Keys starting with `:` match against tag types instead of code types:

```
SVC[:CD-ITEM == diagnosis]         # Tag type = CD-ITEM, tag code = diagnosis
HE[:status == active-relevant]     # Tag type = status, tag code = active-relevant
CTC[:CD-TRANSACTION == consult]    # Tag type = CD-TRANSACTION, tag code = consult
```

### Quoted Strings

Use double quotes for values containing special characters:

```
SVC[BE-THESAURUS-PROCEDURES == "D36.002"{<2y}]
CTC[hcp == "e5cc8099-eb9b-4ac7-8c80-99eb9b0ac7be"]
```

### Variables

Variables are referenced with `$` and are prompted at execution time (or pre-set with `var`):

```
icure-reporting$ var maxAge = 50y
icure-reporting$ query 'PAT[age > $maxAge]'
```

### Reducer Pipeline

Results can be piped through reducers:

```
PAT[age > 50y] | count                              # Count matching patients
PAT[age > 50y] | min(dateOfBirth)                   # Earliest date of birth
PAT[age > 50y] | max(dateOfBirth)                   # Latest date of birth
PAT[age > 50y] | sum(dateOfBirth)                   # Sum (rarely useful for dates)
PAT[age > 50y] | mean(dateOfBirth)                  # Average
PAT[age > 50y] | select(firstName, lastName, gender) # Project specific fields
PAT[age > 50y] | d2y(dateOfBirth)                   # Convert date to age in years
PAT[age > 50y] | d2s(dateOfBirth)                   # Convert date to Unix seconds
```

| Reducer               | Description                                      |
|-----------------------|--------------------------------------------------|
| `count`               | Number of results                                |
| `sum(field)`          | Sum of a numeric field                           |
| `mean(field)`         | Running average                                  |
| `min(field)`          | Minimum value                                    |
| `max(field)`          | Maximum value                                    |
| `select(f1, f2, ...)` | Pick specific fields from each result            |
| `d2s(field)`          | Date (yyyyMMdd) to Unix seconds                  |
| `s2d(field)`          | Unix seconds to date (yyyyMMdd)                  |
| `d2y(field)`          | Date (yyyyMMdd) to age in years                  |
| `share(hcpId1, ...)`  | Share patient data with other healthcare parties |

## Deferred Filtering (`--defer`)

### The Problem

Some queries combine a broad filter with a narrow one:

```
query 'PAT[active=="true" & SVC[ICPC == T89]]'
```

Here, `active=="true"` matches nearly all patients (huge set), while `SVC[ICPC == T89]` matches a small set. The iCure backend must compute the intersection server-side, which is dominated by enumerating the large "active" set -- making the query very slow.

### The Solution

The `--defer` flag moves selected filters out of the server-side query and applies them as client-side post-filters on the (small) result set:

```
query --defer active 'PAT[active=="true" & SVC[ICPC == T89]]'
```

**What happens:**
1. Only `SVC[ICPC == T89]` is sent to the iCure API (fast, returns a small set of patient IDs)
2. The `active=="true"` check is applied locally on each returned patient
3. The result is identical, but much faster

### Available Deferral Policies

| Policy         | Defers                       | Typical use case                                              |
|----------------|------------------------------|---------------------------------------------------------------|
| `active`       | `PAT[active=="true"]`        | Most patients are active -- filtering is nearly a no-op       |
| `gender`       | `PAT[gender == male]`        | ~50% filter, useful when combined with a much narrower filter |
| `age`          | `PAT[age>Ny]`, `PAT[age<Ny]` | Age range filters on patient date of birth                    |
| `all-patients` | `PAT[]` (no condition)       | The catch-all "all patients" filter                           |

### Combining Policies

Multiple policies can be comma-separated:

```
query --defer active,age 'PAT[active=="true" & age>50y & SVC[ICPC == T89]]'
```

This defers both the `active` and `age` filters, sending only the SVC subquery to the server.

### Safety Guarantees

- At least one filter always remains in the API query -- if all intersection members would be deferred, the first one is kept server-side
- Only first-level members of an `IntersectionFilter` are candidates -- nested filters inside subqueries are never deferred
- Only leaf patient filters can be deferred -- composite filters (unions, intersections) and entity subqueries (SVC, HE, CTC) are never deferred
- Without `--defer`, behavior is identical to the original -- no deferral happens by default

### When to Use

Use `--defer active` when your query intersects `active=="true"` with a selective subquery (SVC, HE, CTC). This is the most common performance bottleneck.

Use `--defer active,age` when your query further restricts by age range, but the main selectivity comes from a code-based subquery.

Do **not** use `--defer` if the deferred filter is the most selective part of the query -- deferring it would make the server return a larger result set, potentially making things slower.

## Real-World Query Examples

### Screening

```bash
# Colon cancer screening -- procedures in last 2-5 years, active patients 50-75
query --defer active,age 'SVC[((BE-THESAURUS-PROCEDURES=="D36.002"{<2y} | BE-THESAURUS-PROCEDURES=="D40.001"{<5y}) & (PAT[active=="true"] & PAT[age>50y] & PAT[age<75y]))]'

# Breast cancer screening -- active women 50-70
query --defer active,age,gender 'SVC[(((BE-THESAURUS-PROCEDURES=="X41.002"{<2y} | BE-THESAURUS-PROCEDURES=="X41.005"{<2y} | BE-THESAURUS-PROCEDURES=="X41.007"{<2y})) & (PAT[active=="true"] & PAT[age>50y] & PAT[age<70y] & PAT[(gender=="female" | gender=="changedToMale")]))]'
```

### Health Elements with Exclusions

```bash
# Active patients with diabetes, excluding family risk
query --defer active 'HE[((PAT[active=="true"] & ((ICPC=="T90" | ICPC=="T89") & (:status == active-relevant | :status == active-irrelevant))) - (((ICPC=="T90" | ICPC=="T89") & (:CD-ITEM == familyrisk | :CD-ITEM-EXT-HE-TYPE == familyrisk))))]'

# Smoking in active population
query --defer active 'HE[((PAT[active=="true"] & ICPC=="P17") - ((ICPC=="P17" & (:CD-ITEM == familyrisk | :CD-ITEM-EXT-HE-TYPE == familyrisk))))]'
```

### Contacts and Consultations

```bash
# Active patients with consultations in last 2 years
query --defer active 'PAT[active=="true" & CTC[((:CD-TRANSACTION=="consult"{<2y} | :CD-TRANSACTION=="homevisit"{<2y} | :CD-TRANSACTION=="hospitalvisit"{<2y} | :CD-TRANSACTION=="resthomevisit"{<2y}) | (:CD-ENCOUNTER=="consult"{<2y} | :CD-ENCOUNTER=="homevisit"{<2y}))]]'

# 2025 consultations by specific GPs
query 'CTC[(((:CD-TRANSACTION=="consult"{20250101->20251231} | :CD-TRANSACTION=="homevisit"{20250101->20251231})) & (hcp=="e5cc8099-eb9b-4ac7-8c80-99eb9b0ac7be" | hcp=="b0d9398e-f7ee-4501-9939-8ef7ee95016b"))]'
```

### Vaccination Tracking

```bash
# Flu vaccination 2025-2026 season, active patients 65+
query --defer active,age 'SVC[((CD-VACCINEINDICATION=="seasonalinfluenza"{20250701->20260131} | BE-THESAURUS-PROCEDURES=="R44.003"{20250701->20260131}) & (PAT[active=="true"] & PAT[age>64y]))]'
```

### Medication

```bash
# Active patients on GLP-1 analogues
query --defer active 'SVC[(CD-DRUG-CNK=="3831153" | CD-DRUG-CNK=="4239737" | CD-DRUG-CNK=="4200572") & PAT[active=="true"]]'

# Patients on antidepressants (date range)
query 'SVC[(CD-ATC=="N06A"{20180101->20260331} | CD-ATC=="N06AA01"{20180101->20260331}) & PAT[active=="true"]]'
```

### Exporting

```bash
# Export to Excel
export results.xlsx 'PAT[age>75y] | select(firstName, lastName, dateOfBirth)'

# Export to JSON
export results.json 'SVC[ICPC == T89 & :CD-ITEM == diagnosis]'

# Export with deferral
export --defer active results.xlsx 'PAT[active=="true" & SVC[ICPC == T89]] | select(firstName, lastName)'
```

## Development

```bash
npm run build          # Lint + compile
npm run eslint         # Lint only
npm run test           # Run unit tests (Vitest)
npm run test:watch     # Run tests in watch mode
npm run peg            # Regenerate parser from grammar
```

## Architecture

```
src/
  icure-reporting.ts    CLI entry point, readline REPL, command dispatch
  filters.ts            Query engine: filter rewriting, API calls, reducers, deferral
  xls.ts                XLSX export
  reduceDeep.ts         Deep object/array traversal utilities
  local-storage-shim.ts File-backed localStorage for Node.js (@icure/api key storage)
grammar/
  icure-reporting-parser.peggy   Peggy grammar defining the query DSL
test/
  parser.test.ts                 Grammar parsing unit tests
  clinical-queries.test.ts       Real-world clinical query parsing tests
  deferral.test.ts               Deferral mechanism unit tests
  reduceDeep.test.ts             Deep traversal utility tests
```

**Query execution flow:**

```
User input --> Peggy parser --> AST --> rewriteFilter() --> iCure API calls --> post-filters --> reducers --> output
                                        |                                       |
                                        Subqueries executed eagerly              --defer policies applied here
                                        during rewriting (SVC->patient IDs)
```
