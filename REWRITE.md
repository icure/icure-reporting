# rewriteFilter — Query Compilation Pipeline

## Purpose

`rewriteFilter` is the core query compiler in `filters.ts`. It transforms the abstract syntax tree (AST) produced by the Peggy parser into concrete iCure API filter objects, executing subqueries along the way. The function bridges the gap between the user's DSL query (e.g., `PAT[age>45y & SVC[ICPC == T89]]`) and the iCure backend's filter-based query API.

## Where It Fits

```
User input
    ↓
Peggy parser           → AST (nested objects with $type, entity, filter, etc.)
    ↓
rewriteFilter()        → Rewrites AST into iCure filter objects, executes subqueries
    ↓
handleFinalRequest()   → Executes the top-level filter against iCure API
    ↓
Reducer pipeline       → Optional aggregation (count, sum, select, etc.)
    ↓
Output                 → Console / JSON file / XLSX
```

## Signature

```typescript
async function rewriteFilter(
    filter: any,      // Current AST node being processed
    first: boolean,   // true only for the outermost call (preserves entity + reducers)
    mainEntity: string, // The top-level entity type (PAT, SVC, HE, INV, CTC)
    subEntity: string,  // The current entity context for nested subqueries
): Promise<any>
```

## Input: Parser AST Nodes

The Peggy parser produces nodes with these `$type` values:

| `$type`              | Meaning                             | Key fields                                                                                    |
|----------------------|-------------------------------------|-----------------------------------------------------------------------------------------------|
| `request`            | Entity filter or subtract operation | `entity`, `filter`, `reducers`, or `entity: 'SUBTRACT'` with `left`/`right`                   |
| `UnionFilter`        | OR combination                      | `filters[]`                                                                                   |
| `IntersectionFilter` | AND combination                     | `filters[]`                                                                                   |
| `ComplementFilter`   | Negation                            | `subSet` (and optionally `superSet`)                                                          |
| `PLACEHOLDER`        | Leaf condition from the parser      | `key`, `value`, `colonKey`, `colonValue`, `startDate`, `endDate`, `healthcarePartyId`         |
| iCure filter types   | Already-converted filters           | e.g., `PatientByHcPartyDateOfBirthBetweenFilter`, `PatientByHcPartyGenderEducationProfession` |

## Output: iCure API Filter Objects

The function produces filter objects compatible with the iCure filter API:

- `PatientByHcPartyFilter` — all patients for a healthcare party
- `PatientByIdsFilter` — patients matching specific IDs (from subquery results)
- `ServiceByHcPartyTagCodeDateFilter` — services by tag/code/date range
- `HealthElementByHcPartyTagCodeFilter` — health elements by tag/code
- `InvoiceByHcPartyCodeDateFilter` — invoices by code/date
- `ContactByHcPartyTagCodeDateFilter` — contacts by tag/code/date
- `UnionFilter`, `IntersectionFilter`, `ComplementFilter` — set operations

## Rewriting Mechanism

### Phase 1: Top-level request unwrapping (`first === true`)

When `first` is true, the function preserves the top-level structure (entity type + reducers) and recurses into the inner filter:

```
{ $type: 'request', entity: 'PAT', filter: <inner>, reducers: [...] }
→ { $type: 'request', entity: 'PAT', filter: rewriteFilter(<inner>), reducers: [...] }
```

### Phase 2: Subquery execution (`$type === 'request'`, `first === false`)

When a nested entity request is encountered (e.g., `SVC[...]` inside `PAT[...]`), the function:

1. Recursively rewrites the inner filter
2. **Executes the subquery immediately** against the iCure API (across all HCPs in the hierarchy)
3. Extracts patient IDs from the results via crypto delegation keys
4. Returns a `PatientByIdsFilter` with those IDs

This is the key insight: **subqueries are eagerly evaluated during rewriting**, not deferred. For example:

```
PAT[age>45y & SVC[ICPC == T89]]
```

The `SVC[ICPC == T89]` subquery is executed during rewriting. The services are fetched, their patient IDs extracted via `servicesToPatientIds()`, and the result becomes `PatientByIdsFilter { ids: [...] }`. This patient ID filter is then intersected with the age filter.

### Phase 3: Subtract operations (`entity === 'SUBTRACT'`)

Subtract (`A - B`) is rewritten as `ComplementFilter { superSet: A, subSet: B }` (or `UnionFilter` if multiple right-hand operands).

### Phase 4: Composite filters (`UnionFilter`, `IntersectionFilter`, `ComplementFilter`)

These are recursively rewritten: each child filter is processed, and the composite structure is preserved.

### Phase 5: Leaf conversion (`$type === 'PLACEHOLDER'`)

PLACEHOLDER nodes from the parser are converted to concrete iCure filter types using the `converters` map:

| Entity | Converter output                                                                         |
|--------|------------------------------------------------------------------------------------------|
| SVC    | `ServiceByHcPartyTagCodeDateFilter` with `codeType`/`codeCode`/`tagType`/`tagCode`/dates |
| HE     | `HealthElementByHcPartyTagCodeFilter` with `codeType`/`codeNumber`/`tagType`/`tagCode`   |
| INV    | `InvoiceByHcPartyCodeDateFilter` with `code`/dates                                       |
| CTC    | `ContactByHcPartyTagCodeDateFilter` with `codeType`/`codeCode`/`tagType`/`tagCode`/dates |

### Phase 6: Pass-through

Already-concrete filter types (like `PatientByHcPartyDateOfBirthBetweenFilter` produced directly by the parser for age conditions) are returned as-is.

## Healthcare Party Hierarchy

All subquery executions fan out across the full HCP hierarchy. On initialization, the function walks up the `parentId` chain to build `hcpHierarchy[]`. Each API call is then made once per HCP in the hierarchy, and results are merged with `uniqBy(id)`.

## Patient ID Extraction

When a subquery (SVC, HE, INV, CTC) runs inside a PAT context, the results must be converted to patient IDs. This uses `cryptoApi.extractKeysFromDelegationsForHcpHierarchy()` to decrypt the `cryptedForeignKeys` delegation chain on each entity, yielding the associated patient IDs.

| Helper                  | Input             | Delegation source                                   |
|-------------------------|-------------------|-----------------------------------------------------|
| `servicesToPatientIds`  | `Service[]`       | `svc.cryptedForeignKeys` (keyed by `svc.contactId`) |
| `helementsToPatientIds` | `HealthElement[]` | `he.cryptedForeignKeys` (keyed by `he.id`)          |
| `invoicesToPatientIds`  | `Invoice[]`       | `inv.cryptedForeignKeys` (keyed by `inv.id`)        |
| `contactsToPatientIds`  | `Contact[]`       | `ctc.cryptedForeignKeys` (keyed by `ctc.id`)        |

## Post-Rewrite: handleFinalRequest

After rewriting, the top-level filter is executed by `handleFinalRequest()`:

1. Dispatches to the appropriate iCure API based on `entity` (PAT, SVC, HE, INV, CTC)
2. Applies the reducer pipeline (if any) sequentially over the result rows
3. Returns the final result set

## Example Walkthrough

Query: `PAT[age>45y & SVC[ICPC == T89 & :CD-ITEM == diagnosis]] | select(lastName)`

1. **Parser** produces:
   ```
   { $type: 'request', entity: 'PAT', filter: IntersectionFilter, reducers: [select(lastName)] }
   ```

2. **rewriteFilter (first=true)**: Preserves entity + reducers, recurses into IntersectionFilter

3. **rewriteFilter (IntersectionFilter)**: Recurses into both children:
   - Child 1: `PatientByHcPartyDateOfBirthBetweenFilter` (from age>45y) → returned as-is
   - Child 2: `{ $type: 'request', entity: 'SVC', filter: ... }` → triggers subquery execution

4. **Subquery execution (SVC)**:
   - Inner filter rewritten: PLACEHOLDER → `ServiceByHcPartyTagCodeDateFilter { codeType: 'ICPC', codeCode: 'T89', tagType: 'CD-ITEM', tagCode: 'diagnosis' }`
   - `contactApi.filterServicesBy()` called for each HCP in hierarchy
   - Results deduplicated by service ID
   - `servicesToPatientIds()` extracts patient IDs via delegation keys
   - Returns `PatientByIdsFilter { ids: [...] }`

5. **Result**: `IntersectionFilter { filters: [DateOfBirthFilter, PatientByIdsFilter] }`

6. **handleFinalRequest**: `patientApi.filterByWithUser()` with the intersection filter

7. **Reducer**: `select(lastName)` picks only `lastName` from each patient row
