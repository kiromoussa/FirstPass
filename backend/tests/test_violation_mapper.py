import pytest

from app.models.schemas import ExtractedElements, Issue, IssueSeverity, Room, Violation
from app.services.violation_mapper import (
    build_floor_plan_features,
    build_violations,
    issues_to_violations,
)


def test_issues_to_violations_maps_fields():
    issues = [
        Issue(
            category="egress",
            severity=IssueSeverity.CRITICAL,
            title="Bedroom egress window too small",
            description="Primary bedroom lacks compliant egress opening",
            code_reference="IRC R310",
        )
    ]

    violations = issues_to_violations(issues)

    assert len(violations) == 1
    assert violations[0].code_section == "IRC R310"
    assert violations[0].issue == "Bedroom egress window too small"
    assert violations[0].severity == "high"
    assert violations[0].location == "bedroom"


def test_build_violations_falls_back_to_potential_issues():
    elements = ExtractedElements(
        potential_issues=["Narrow hallway may block egress path"],
        rooms=[Room(name="Hallway")],
    )

    violations = build_violations(elements, issues=[])

    assert len(violations) == 1
    assert violations[0].issue == "Narrow hallway may block egress path"
    assert violations[0].code_section == "unclear"


def test_build_floor_plan_features_serializes_elements():
    elements = ExtractedElements(rooms=[Room(name="Kitchen", label="KIT")])

    features = build_floor_plan_features(elements)

    assert features["rooms"][0]["name"] == "Kitchen"
    assert features["rooms"][0]["label"] == "KIT"
