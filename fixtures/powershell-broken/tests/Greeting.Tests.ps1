BeforeAll {
  . (Join-Path $PSScriptRoot '..' 'Greeting.ps1')
}

Describe 'Get-Greeting' {
  It 'passes' {
    Get-Greeting -Name 'Ward' | Should -Be 'Hello, Ward'
  }

  It 'fails on purpose' {
    Get-Greeting -Name 'Ward' | Should -Be 'Goodbye, Ward'
  }
}
