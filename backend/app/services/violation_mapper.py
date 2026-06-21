from app.models.schemas import ExtractedElements, Issue, IssueSeverity, Violation

SEVERITY_TO_VIOLATION = {
    IssueSeverity.INFO: "low",
    IssueSeverity.WARNING: "medium",
    IssueSeverity.CRITICAL: "high",
}


def build_floor_plan_features(elements: ExtractedElements) -> dict:
    """Serialize extracted floor plan elements for the recommendation engine."""
    return elements.model_dump()


def issues_to_violations(issues: list[Issue]) -> list[Violation]:
    """Map analyzer issues into recommendation-engine violation input."""
    violations: list[Violation] = []
    for issue in issues:
        violations.append(
            Violation(
                code_section=issue.code_reference or "unclear",
                issue=issue.description if issue.title.startswith("Potential issue") else issue.title,
                location=_infer_location(issue.description),
                evidence=issue.description,
                severity=SEVERITY_TO_VIOLATION.get(issue.severity, "medium"),
            )
        )
    return violations


def build_violations(
    elements: ExtractedElements,
    issues: list[Issue],
) -> list[Violation]:
    """
    Build violations from analyzer output.

    Uses structured issues when present; falls back to raw potential_issues strings
    from vision extraction when issue objects were not produced.
    """
    if issues:
        return issues_to_violations(issues)

    return [
        Violation(
            code_section="unclear",
            issue=description,
            location=_infer_location(description),
            evidence=description,
            severity="medium",
        )
        for description in elements.potential_issues
        if description.strip()
    ]


def _infer_location(description: str) -> str | None:
    lowered = description.lower()
    for keyword in ("bedroom", "kitchen", "bathroom", "hallway", "stair", "garage", "adu"):
        if keyword in lowered:
            return keyword
    return None
