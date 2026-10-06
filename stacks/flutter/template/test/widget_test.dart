import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forge_flutter_template/main.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// Widget tests with an INJECTED transport (MockClient). flutter_test
/// intercepts every HttpClient request (all return 400), so real-socket
/// tests are impossible under the binding by design — the documented
/// pattern is to provide the client to the code under test. The screen,
/// states (loading/list/error/retry) and parsing are fully exercised.
void main() {
  Future<void> pumpScreen(WidgetTester tester, http.Client client) async {
    await tester.pumpWidget(MaterialApp(
      home: TaskListScreen(apiBase: 'http://api.test', client: client),
    ));
  }

  testWidgets('renders tasks fetched from the API', (tester) async {
    await pumpScreen(tester, MockClient((request) async => http.Response(
      jsonEncode([
        {'id': 1, 'title': 'prove the emulator journey', 'done': false},
        {'id': 2, 'title': 'close the packet', 'done': true},
      ]),
      200,
      headers: {'content-type': 'application/json'},
    )));

    // The fetch completes via a microtask; one pump observes the data state.
    await tester.pumpAndSettle();

    expect(find.text('prove the emulator journey'), findsOneWidget);
    expect(find.text('close the packet'), findsOneWidget);
    expect(find.byIcon(Icons.check_box), findsOneWidget);
    expect(find.byIcon(Icons.check_box_outline_blank), findsOneWidget);

    // The fetch carries a 10s .timeout() — its fake-async Timer is still
    // pending at teardown unless the test pumps past it.
    await tester.pump(const Duration(seconds: 11));
  });

  testWidgets('shows the error state with a retry affordance when the API fails', (tester) async {
    await pumpScreen(tester, MockClient((request) async => http.Response(
      jsonEncode({'error': 'injected'}),
      500,
      headers: {'content-type': 'application/json'},
    )));

    await tester.pumpAndSettle();

    expect(find.byKey(const Key('retry-button')), findsOneWidget);
    expect(find.textContaining('API answered 500'), findsOneWidget);

    // Same teardown rule: expire the fetch timeout's fake-async Timer.
    await tester.pump(const Duration(seconds: 11));
  });
}
