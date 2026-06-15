import unittest

from no_website_finder import (
    build_address,
    build_overpass_query,
    domain_of,
    extract_duckduckgo_target,
    filtered_leads,
    has_source_website,
    is_directory_or_social,
    make_leads,
    normalize_categories,
    parse_bbox,
)


class FinderTests(unittest.TestCase):
    def test_parse_bbox(self):
        self.assertEqual(parse_bbox("30.1,-97.9,30.5,-97.5"), (30.1, -97.9, 30.5, -97.5))

    def test_normalize_categories_rejects_unknown(self):
        with self.assertRaises(ValueError):
            normalize_categories("plumbers,unknown")

    def test_build_overpass_query_includes_bbox_and_tags(self):
        query = build_overpass_query((1.0, 2.0, 3.0, 4.0), [("craft", "plumber"), ("shop", None)])
        self.assertIn('nwr["craft"="plumber"](1.0,2.0,3.0,4.0);', query)
        self.assertIn('nwr["shop"](1.0,2.0,3.0,4.0);', query)

    def test_has_source_website_checks_contact_website(self):
        self.assertTrue(has_source_website({"contact:website": "https://example.com"}))
        self.assertFalse(has_source_website({"phone": "555-0100"}))

    def test_build_address(self):
        address = build_address(
            {
                "addr:housenumber": "123",
                "addr:street": "Main St",
                "addr:city": "Austin",
                "addr:state": "TX",
                "addr:postcode": "78701",
            }
        )
        self.assertEqual(address, "123 Main St Austin TX 78701")

    def test_duckduckgo_redirect_target(self):
        target = extract_duckduckgo_target(
            "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F&rut=abc"
        )
        self.assertEqual(target, "https://example.com/")

    def test_domain_filtering(self):
        self.assertEqual(domain_of("https://www.example.com/path"), "example.com")
        self.assertTrue(is_directory_or_social("https://www.yelp.com/biz/example"))
        self.assertFalse(is_directory_or_social("https://exampleplumbing.com"))

    def test_make_leads_filters_existing_websites_and_dedupes(self):
        elements = [
            {
                "type": "node",
                "id": 1,
                "tags": {"name": "A Plumbing", "craft": "plumber", "website": "https://a.example"},
            },
            {
                "type": "node",
                "id": 2,
                "tags": {"name": "B Plumbing", "craft": "plumber", "phone": "555-0100"},
            },
            {
                "type": "node",
                "id": 3,
                "tags": {"name": "B Plumbing", "craft": "plumber", "phone": "555-0100"},
            },
        ]
        leads = make_leads(elements, "Austin, Texas", verify_search=False, search_delay=0)
        self.assertEqual(len(leads), 1)
        self.assertEqual(leads[0].name, "B Plumbing")
        self.assertEqual(leads[0].no_website_confidence, "medium")

    def test_filtered_leads_removes_low_confidence(self):
        elements = [
            {
                "type": "node",
                "id": 2,
                "tags": {"name": "B Plumbing", "craft": "plumber"},
            },
        ]
        leads = make_leads(elements, "Austin, Texas", verify_search=False, search_delay=0)
        leads[0].no_website_confidence = "low"
        self.assertEqual(filtered_leads(leads, True), [])


if __name__ == "__main__":
    unittest.main()
